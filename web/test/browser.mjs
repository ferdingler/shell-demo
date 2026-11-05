import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const origin = process.env.DEMO_ORIGIN || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(15000)
const requests = []
const errors = []
const checks = []
page.on('request', request => requests.push(request.url()))
page.on('pageerror', error => errors.push(error.message))
page.on('console', message => {
  if (message.type() === 'error') errors.push(message.text())
})

// Observe the real worker boundary without adding test APIs to the application.
await page.addInitScript(() => {
  const BrowserWorker = window.Worker
  window.shellResults = []
  window.shellInputs = []
  window.Worker = class extends BrowserWorker {
    constructor(...args) {
      super(...args)
      this.addEventListener('message', ({ data }) => {
        if (data.type === 'result') window.shellResults.push(data)
      })
    }
    postMessage(data, ...args) {
      window.shellInputs.push(data)
      return super.postMessage(data, ...args)
    }
  }
})

async function ready() {
  await page.waitForFunction(() => document.body.dataset.state === 'ready', null, { timeout: 35000 })
}

async function screen() {
  return page.locator('.xterm-rows').innerText()
}

async function checkBounds() {
  assert.equal(await page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect()
    const container = document.querySelector('#terminal').getBoundingClientRect()
    const footer = document.querySelector('.statusbar').getBoundingClientRect()
    return screen.right <= container.right && screen.bottom <= container.bottom && screen.bottom <= footer.top
  }), true, 'Terminal cells stay inside the viewport and above the footer')
  assert.equal(await page.locator('.xterm-viewport').evaluate(e => getComputedStyle(e).backgroundColor),
    'rgb(19, 22, 21)', 'Unused terminal space matches the page background')
}

async function type(script) {
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.insertText(script)
}

async function enter() {
  const count = await page.evaluate(() => window.shellResults.length)
  await page.keyboard.press('Enter')
  await page.waitForFunction(n => window.shellResults.length > n, count)
  await ready()
  await checkBounds()
  return page.evaluate(() => window.shellResults.at(-1))
}

async function command(script, expected, status = 0) {
  await type(script)
  const result = await enter()
  assert.equal(result.stdout, expected, script)
  assert.equal(result.status, status, script)
  checks.push(script)
  console.log(`PASS ${script}`)
  return result
}

async function paste(text) {
  await page.locator('.xterm-helper-textarea').evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

try {
  await mkdir('test-results', { recursive: true })
  await page.goto(origin)
  await ready()
  assert.equal(await page.locator('.xterm-helper-textarea').evaluate(e => e === document.activeElement), true)
  assert.match(await screen(), /A sandboxed, Bourne-compatible shell for AI agents/)
  await page.screenshot({ path: 'test-results/initial-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  await checkBounds()
  await page.screenshot({ path: 'test-results/initial-mobile.png' })
  await type('echo rsize')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(150)
  await type('e')
  assert.equal((await enter()).stdout, 'resize\n')
  checks.push('Opening adapts to mobile and preserves input and cursor when resized')
  await command('pwd', '/home/lash/workspace\n')
  await command('echo hello | tr a-z A-Z', 'HELLO\n')
  assert.match(await screen(), /HELLO/)
  await command("printf 'persistent\\n' > note.txt; export DEMO=browser", '')
  await command('cat note.txt; echo "$DEMO"', 'persistent\nbrowser\n')
  await command('mkdir nested; cd nested', '')
  assert.match(await screen(), /workspace\/nested/)
  await command('pwd; cd ..', '/home/lash/workspace/nested\n')
  await command('for n in 1 2 3; do echo "$n"; done', '1\n2\n3\n')
  await command('false', '', 1)
  await command('echo $?', '1\n')
  await command('lua -e "print(math.sqrt(144))"', '12\n')
  await command('lua -e "error(\'intentional\')"', '', 1)
  await command('lua -e "print(6 * 7)"', '42\n')
  const sleep = await command('sleep 0.1; echo awake', 'awake\n')
  assert.ok(sleep.elapsed >= 90)
  await command('grep ERROR app.log | wc -l', '      3\n')
  await command("jq -r '.[] | .name' projects.json", 'Strands Shell\nPaper Plane\nLittle Planet\n')
  await command('sort words.txt | uniq -c', '      2 apple\n      1 banana\n      1 orange\n      2 pear\n')

  await type('echo hllo')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await type('e')
  assert.equal((await enter()).stdout, 'hello\n')
  await type('echo draft')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowDown')
  assert.equal((await enter()).stdout, 'draft\n')
  await type('garbage')
  await page.keyboard.press('Control+u')
  await type('echo removed')
  await page.keyboard.press('Control+w')
  await type('edited')
  assert.equal((await enter()).stdout, 'edited\n')
  await type('echo deleteX')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Home')
  await page.keyboard.press('End')
  assert.equal((await enter()).stdout, 'delete\n')
  await type('echo never')
  await page.keyboard.press('Control+c')
  await command('echo alive', 'alive\n')
  checks.push('Cursor editing, Delete, Home/End, history/draft, Ctrl+U/W/C')

  await type('pw')
  await page.keyboard.press('Tab')
  assert.equal((await enter()).stdout, '/home/lash/workspace\n')
  await type('cat no')
  await page.keyboard.press('Tab')
  assert.equal((await enter()).stdout, 'persistent\n')
  checks.push('Tab completes commands and current workspace files')

  await type('echo first')
  await page.keyboard.press('Shift+Enter')
  await type('echo second')
  assert.equal((await enter()).stdout, 'first\nsecond\n')
  const beforePaste = await page.evaluate(() => window.shellInputs.length)
  await paste("echo pasted\necho safely\n")
  assert.equal(await page.evaluate(() => window.shellInputs.length), beforePaste)
  assert.equal((await enter()).stdout, 'pasted\nsafely\n')
  checks.push('Multiline editing and paste wait for Enter')

  await type('echo 世界é')
  await page.keyboard.press('Backspace')
  assert.equal((await enter()).stdout, '世界\n')
  const longText = 'x'.repeat(300)
  await type(`echo ${longText}`)
  await page.keyboard.press('Home')
  await page.keyboard.press('End')
  await type('y')
  assert.equal((await enter()).stdout, `${longText}y\n`)
  checks.push('Unicode deletion and editing wrapped commands')

  const requestCount = requests.length
  const denied = await command('curl https://example.com', '', 6)
  assert.match(denied.stderr, /denied/i)
  await command(`echo '<img src=x onerror=alert(1)>'`, '<img src=x onerror=alert(1)>\n')
  assert.equal(await page.locator('main img').count(), 0)
  await context.setOffline(true)
  await command('cat note.txt; echo offline', 'persistent\noffline\n')
  await context.setOffline(false)
  assert.equal(requests.length, requestCount)
  checks.push('Network denied, no execution requests, offline commands, text-safe output')

  await type('while true; do :; done')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.body.dataset.state === 'busy')
  await page.keyboard.press('Control+c')
  await ready()
  assert.match(await screen(), /workspace was reset/)
  await command('test -f note.txt', '', 1)
  await type('while true; do :; done')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.body.dataset.state === 'busy')
  await ready()
  assert.match(await screen(), /5-second limit/)
  checks.push('Interruption and watchdog restore a working shell')

  await type('echo preserved')
  await page.keyboard.press('Control+l')
  assert.equal((await enter()).stdout, 'preserved\n')
  await page.locator('#reset').click()
  await page.getByRole('button', { name: 'Keep working' }).click()
  await command('echo cancelled', 'cancelled\n')
  await page.locator('#reset').click()
  await page.locator('dialog button[value=reset]').click()
  await ready()
  assert.match(await screen(), /A sandboxed, Bourne-compatible shell for AI agents/)
  await command('ls', 'README.txt\napp.log\nprojects.json\nwords.txt\n')
  checks.push('Clear preserves input; reset confirmation and cancellation')

  await page.locator('#clear').click()
  await command('ls', 'README.txt\napp.log\nprojects.json\nwords.txt\n')
  await command('grep ERROR app.log', '09:00:03 ERROR request timed out\n09:00:05 ERROR missing customer id\n09:00:07 ERROR upload failed\n')
  await command("jq -r '.[] | .name' projects.json", 'Strands Shell\nPaper Plane\nLittle Planet\n')
  await page.screenshot({ path: 'test-results/desktop.png' })
  await type('echo resize')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(150)
  await checkBounds()
  assert.equal((await enter()).stdout, 'resize\n')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: 'test-results/mobile.png' })
  await page.setViewportSize({ width: 390, height: 360 })
  await command('echo keyboard', 'keyboard\n')
  await checkBounds()
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true)
  checks.push('Resize preserves input; mobile and soft-keyboard-height layouts')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  await ready()
  await page.locator('#clear').click()
  await page.waitForFunction(() => !document.querySelector('.xterm-rows').innerText.includes('A sandboxed, Bourne-compatible shell for AI agents'))
  await page.locator('#help').click()
  await page.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('Bourne-compatible shell'))
  await page.screenshot({ path: 'test-results/help.png' })

  await page.locator('#accessibility').focus()
  await page.locator('#accessibility').click()
  await page.keyboard.type('echo accessible')
  assert.equal((await enter()).stdout, 'accessible\n')
  assert.ok(await page.locator('.xterm-accessibility-tree').count())
  checks.push('Screen reader mode can be enabled by keyboard and runs commands')

  const unsupported = await context.newPage()
  await unsupported.addInitScript(() => { WebAssembly.Suspending = undefined })
  await unsupported.goto(origin)
  await unsupported.waitForFunction(() => document.body.dataset.state === 'failed')
  await unsupported.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('Chrome or Edge'))
  assert.match(await unsupported.locator('.xterm-rows').innerText(), /Chrome or Edge/)
  await unsupported.close()
  checks.push('Help, reduced motion, unsupported-browser recovery message')

  const subdirectory = await context.newPage()
  await subdirectory.route(`${origin}/demo/**`, async route => {
    const url = route.request().url().replace(`${origin}/demo/`, `${origin}/`)
    await route.fulfill({ response: await context.request.get(url) })
  })
  await subdirectory.goto(`${origin}/demo/`)
  await subdirectory.waitForFunction(() => document.body.dataset.state === 'ready')
  await subdirectory.keyboard.type('pwd')
  await subdirectory.keyboard.press('Enter')
  await subdirectory.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('/home/lash/workspace'))
  await subdirectory.close()
  checks.push('Static assets and worker load under a hosting subdirectory')
  assert.deepEqual(errors, [])
  const report = { browser: browser.version(), checks, requests, errors }
  await writeFile('test-results/browser-check.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.error('Visible terminal:', await screen())
  await page.screenshot({ path: 'test-results/failure.png' })
  throw error
} finally {
  await browser.close()
}
