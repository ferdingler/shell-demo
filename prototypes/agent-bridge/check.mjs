// Concrete experiment: real MCP stdio client -> relay -> Chromium -> WASM shell.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const origin = process.env.DEMO_ORIGIN || 'http://127.0.0.1:4180'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const errors = []
const checks = []
const clients = []
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.setDefaultTimeout(15000)
await page.addInitScript(() => {
  const BaseWorker = Worker
  window.results = []
  window.Worker = class extends BaseWorker {
    constructor(...args) {
      super(...args)
      this.addEventListener('message', ({ data }) => {
        if (data.type === 'result') window.results.push(data)
      })
    }
  }
})
const pass = name => { checks.push(name); console.log(`PASS ${name}`) }
const ready = () => page.waitForFunction(() => document.body.dataset.state === 'ready')
const call = (client, name, args = {}) => client.callTool(
  { name, arguments: args }, undefined, { timeout: 120_000 },
)
const text = value => value.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
const exec = async (client, command) => {
  const reply = await call(client, 'shell_exec', { command })
  assert.ok(!reply.isError, text(reply))
  return JSON.parse(text(reply))
}
async function clientFor(sessionId, name = 'Prototype test agent') {
  const client = new Client({ name, version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('prototypes/agent-bridge/mcp.mjs'), '--session', sessionId],
    stderr: 'pipe',
    env: { ...process.env },
  })
  await client.connect(transport)
  clients.push(client)
  return client
}
async function openConnection() {
  await page.click('#connect-agent')
  await page.locator('#agent-details').waitFor({ state: 'visible' })
  return page.locator('#agent-session-id').textContent()
}
async function approve(client) {
  const connected = call(client, 'shell_connect')
  await page.locator('#agent-approval').waitFor({ state: 'visible' })
  await page.click('#agent-allow')
  const reply = await connected
  assert.ok(!reply.isError, text(reply))
  assert.equal(JSON.parse(text(reply)).connected, true)
}
async function human(command) {
  await ready()
  const count = await page.evaluate(() => window.results.length)
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.insertText(command)
  await page.keyboard.press('Enter')
  await page.waitForFunction(n => window.results.length > n, count)
  await ready()
  return page.evaluate(() => window.results.at(-1))
}
try {
  await mkdir('test-results', { recursive: true })
  await page.goto(origin)
  await ready()
  const sessionId = await openConnection()
  const client = await clientFor(sessionId)
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['shell_connect', 'shell_disconnect', 'shell_exec'])
  pass('Standard MCP initialize and tool discovery')
  assert.equal((await call(client, 'shell_exec', { command: 'touch unapproved' })).isError, true)
  pass('No command execution before browser approval')

  const denied = call(client, 'shell_connect')
  await page.locator('#agent-approval').waitFor({ state: 'visible' })
  await page.click('#agent-deny')
  assert.equal((await denied).isError, true)
  pass('Browser can decline the agent')
  await approve(client)
  pass('Browser approval establishes the connection')
  const intruder = await clientFor(sessionId, 'Second agent')
  assert.equal((await call(intruder, 'shell_connect')).isError, true)
  assert.equal((await call(intruder, 'shell_exec', { command: 'touch stolen' })).isError, true)
  pass('Another MCP connection cannot take over an approved session')

  assert.equal((await human('printf from-human > shared.txt')).status, 0)
  assert.equal((await exec(client, 'cat shared.txt')).stdout, 'from-human')
  assert.equal((await exec(client, 'grep ERROR app.log > errors.txt; wc -l < errors.txt')).stdout.trim(), '3')
  assert.match((await human('cat errors.txt')).stdout, /ERROR request timed out/)
  pass('Human and MCP agent read and modify the same real WASM filesystem')
  assert.equal((await exec(client, 'mkdir -p analysis; cd analysis; export AGENT_VALUE=connected; pwd')).stdout,
    '/home/lash/workspace/analysis\n')
  assert.equal((await exec(client, 'printf "$AGENT_VALUE"')).stdout, 'connected')
  assert.equal((await human('pwd')).stdout, '/home/lash/workspace/analysis\n')
  await exec(client, 'cd ..')
  pass('Directory and environment persist across human and agent commands')
  const failed = await exec(client, 'echo problem >&2; false')
  assert.equal(failed.status, 1)
  assert.equal(failed.stderr, 'problem\n')
  pass('MCP receives stdout, stderr, exit code, cwd, and timing')

  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.insertText('echo drft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await exec(client, 'echo agent-interleaving')
  await page.keyboard.insertText('a')
  await page.keyboard.press('Enter')
  await ready()
  await page.waitForFunction(() => window.results.at(-1)?.stdout === 'draft\n')
  pass('Remote output preserves the human’s unfinished command and cursor')
  assert.match(await page.locator('.xterm-rows').innerText(), /\[agent\]/)
  await page.screenshot({ path: 'test-results/agent-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.click('#connect-agent')
  await page.screenshot({ path: 'test-results/agent-mobile.png' })
  assert.equal(await page.evaluate(() => {
    const rect = document.querySelector('#agent-dialog').getBoundingClientRect()
    return rect.width <= innerWidth && rect.height <= innerHeight
  }), true)
  await page.click('#agent-close')
  await page.setViewportSize({ width: 1440, height: 900 })
  pass('Live agent commands are visible; connection panel fits mobile')

  const busy = human('sleep 1')
  await page.waitForFunction(() => document.body.dataset.state === 'busy')
  const collision = await call(client, 'shell_exec', { command: 'echo collision' })
  assert.equal(collision.isError, true)
  assert.match(text(collision), /busy/)
  await busy
  pass('Agent cannot race a command already running in the browser')

  await page.click('#connect-agent')
  await page.click('#agent-disconnect')
  assert.equal((await call(client, 'shell_exec', { command: 'echo revoked' })).isError, true)
  pass('Disconnect immediately revokes agent access')
  const nextId = await openConnection()
  const next = await clientFor(nextId, 'Interruption test agent')
  await approve(next)
  const stopped = call(next, 'shell_exec', { command: 'while true; do :; done' })
  await page.waitForFunction(() => document.body.dataset.state === 'busy')
  await page.click('#stop')
  assert.equal((await stopped).isError, true)
  await ready()
  assert.equal((await call(next, 'shell_exec', { command: 'echo still-connected' })).isError, true)
  assert.notEqual((await human('cat errors.txt')).status, 0)
  pass('Stop cancels the agent, resets the shell, and revokes access')

  const timeoutId = await openConnection()
  const timeoutClient = await clientFor(timeoutId, 'Timeout test agent')
  await approve(timeoutClient)
  assert.equal((await call(timeoutClient, 'shell_exec', { command: 'while true; do :; done' })).isError, true)
  await ready()
  assert.equal((await call(timeoutClient, 'shell_exec', { command: 'echo nope' })).isError, true)
  pass('Five-second WASM watchdog also works for remote commands')

  const closingId = await openConnection()
  const closingClient = await clientFor(closingId, 'Tab-close test agent')
  await approve(closingClient)
  await page.close()
  assert.equal((await call(closingClient, 'shell_exec', { command: 'echo gone' })).isError, true)
  pass('Closing the browser tab ends access')

  const badOrigin = new URL('/agent-session', origin)
  badOrigin.protocol = 'ws:'
  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket(badOrigin, { origin: 'https://unrelated.invalid' })
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode) })
    ws.on('open', () => { ws.close(); reject(new Error('Foreign origin accepted')) })
    ws.on('error', () => {})
  })
  assert.equal(status, 403)
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(origin, { headers: { Host: 'unrelated.invalid' } }, response => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })
  assert.equal(badHostStatus, 403)
  assert.equal((await fetch(`${origin}/api/exec`, { method: 'POST' })).status, 405)
  const socket = await stat(process.env.SHELL_BRIDGE_SOCKET ||
    join(tmpdir(), `strands-shell-agent-${process.getuid()}`, 'relay.sock'))
  assert.equal(socket.mode & 0o777, 0o600)
  pass('Foreign origins and hosts rejected; no HTTP command endpoint; Unix socket owner-only')
  assert.deepEqual(errors, [])
  pass('No browser JavaScript errors')
} finally {
  for (const client of clients) await client.close().catch(() => {})
  await browser.close()
  await writeFile('test-results/agent-check.json', JSON.stringify({ checks, errors }, null, 2))
}
