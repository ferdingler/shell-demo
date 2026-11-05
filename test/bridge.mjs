// End-to-end check for bridge/bridge.mjs: drives it as an MCP client over
// stdio and pairs a real browser tab. Needs `npm run preview -- --port 4173`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { chromium } from 'playwright'

const origin = process.env.DEMO_ORIGIN || 'http://127.0.0.1:4173'
const port = 7391
const bridge = spawn(process.execPath, ['bridge/bridge.mjs', '--port', String(port), '--page-url', `${origin}/`], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
const pairingUrl = await new Promise((resolve, reject) => {
  createInterface({ input: bridge.stderr }).on('line', line => {
    if (process.env.VERBOSE) console.error(line)
    const match = line.match(/pairing URL: (\S+)/)
    if (match) resolve(match[1])
  })
  bridge.on('exit', code => reject(new Error(`bridge exited with ${code}`)))
})

let nextId = 0
const waiting = new Map()
createInterface({ input: bridge.stdout }).on('line', line => {
  const message = JSON.parse(line) // stdout must carry JSON-RPC only
  waiting.get(message.id)?.(message)
  waiting.delete(message.id)
})
function rpc(method, params, timeout = 20000) {
  const id = ++nextId
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error(`${method} got no reply within ${timeout / 1000}s`))
    }, timeout)
    waiting.set(id, message => {
      clearTimeout(timer)
      resolve(message)
    })
  })
}
const runShell = command => rpc('tools/call', { name: 'run_shell', arguments: { command } }).then(m => m.result)

function upgrade(fromOrigin) {
  return new Promise(resolve => {
    request({
      host: '127.0.0.1', port, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', Origin: fromOrigin,
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    }).on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode) })
      .on('response', response => resolve(response.statusCode))
      .on('error', () => resolve('error'))
      .end()
  })
}

const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined })
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const list = await rpc('tools/list')
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['run_shell', 'pairing_url'])
  assert.equal((await rpc('nope')).error.code, -32601)
  console.log('PASS initialize, tools/list, unknown method')

  const offline = await runShell('echo hi')
  assert.equal(offline.isError, true)
  assert.match(offline.content[0].text, /pairing URL/)
  console.log('PASS run_shell without a tab asks for pairing')

  assert.equal(await upgrade('https://evil.example'), 403)
  assert.equal(await upgrade(origin), 101)
  console.log('PASS wrong Origin rejected (403), allowed Origin upgrades (101)')

  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } })
  await page.goto(pairingUrl.replace(/pair=[^&]+/, 'pair=wrong-token'))
  await page.waitForFunction(() => document.querySelector('#agent-status').dataset.state === 'rejected')
  assert.equal((await runShell('echo hi')).isError, true)
  console.log('PASS wrong pairing token rejected')

  await page.goto('about:blank')
  await page.goto(pairingUrl)
  await page.waitForFunction(() => document.querySelector('#agent-status').dataset.state === 'connected')
  assert.equal(new URL(page.url()).hash, '', 'token is stripped from the address bar')
  await page.waitForFunction(() => document.body.dataset.state === 'ready', null, { timeout: 35000 })
  console.log('PASS pairing connects and strips the token from the URL')

  for (const [command, expected] of [
    ['echo hi | tr a-z A-Z', /exit status: 0\ncwd: \/home\/lash\/workspace\nstdout:\nHI\n/],
    ['ls', /README\.txt/],
    ['cd /tmp; pwd', /cwd: \/tmp\nstdout:\n\/tmp\n/],
    ['cat missing.txt', /exit status: 1[\s\S]*stderr:\n.+/],
  ]) {
    const result = await runShell(command)
    assert.equal(result.isError, false, command)
    assert.match(result.content[0].text, expected, command)
    console.log(`PASS run_shell ${command}\n${result.content[0].text.replace(/^/gm, '    ')}`)
  }
  await page.click('#reset')
  const queued = runShell('echo after-dialog')
  await page.waitForTimeout(300)
  await page.click('#reset-dialog button[value="cancel"]')
  const afterDialog = await queued
  assert.match(afterDialog.content[0].text, /stdout:\nafter-dialog\n/)
  console.log('PASS agent command queued behind the reset dialog runs once it closes')

  const screen = await page.locator('.xterm-rows').innerText()
  assert.match(screen, /agent › ~\/workspace ❯ echo hi \| tr a-z A-Z/)
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/agent-bridge.png' })
  console.log('PASS terminal shows agent commands (test-results/agent-bridge.png)')

  const unsupported = await browser.newPage()
  await unsupported.addInitScript(() => { delete WebAssembly.Suspending })
  await unsupported.goto(pairingUrl)
  await unsupported.waitForFunction(() => document.querySelector('#agent-status').dataset.state === 'connected')
  const started = Date.now()
  const refused = await runShell('echo hi')
  assert.equal(refused.isError, true)
  assert.match(refused.content[0].text, /unavailable: .*JSPI/)
  assert.ok(Date.now() - started < 2000, 'refusal arrives without waiting for the timeout')
  console.log('PASS a tab that cannot run the shell refuses agent commands right away')
} finally {
  await browser.close()
  bridge.kill()
}
