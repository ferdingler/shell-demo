import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { LineEditor } from './line-editor.js'
import { intro } from './intro.js'
import { createAgentBridge } from './agent-bridge.js'
import { colors as c, displayPath, plainText, terminalText, wrapText } from './terminal-text.js'
import './style.css'

const container = document.querySelector('#terminal')
const status = document.querySelector('#runtime-status')
const result = document.querySelector('#last-result')
const stop = document.querySelector('#stop')
const help = document.querySelector('#help')
const dialog = document.querySelector('#reset-dialog')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const smallScreen = matchMedia('(max-width: 650px)')
const term = new Terminal({
  allowProposedApi: true,
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontSize: smallScreen.matches ? 13 : 14,
  fontWeight: '400',
  fontWeightBold: '500',
  lineHeight: 1.2,
  cursorStyle: 'block',
  cursorBlink: !reducedMotion.matches,
  scrollback: 3000,
  convertEol: true,
  screenReaderMode: false,
  theme: {
    background: '#131615', foreground: '#dce1d9',
    cursor: '#b5db95', cursorAccent: '#131615',
    selectionBackground: '#40523d', selectionInactiveBackground: '#303e2f',
    black: '#202620', red: '#ed968c', green: '#b5db95', yellow: '#dfc184',
    blue: '#92b9cc', magenta: '#c5a6c9', cyan: '#8ccdc0', white: '#dce1d9',
    brightBlack: '#8e9992', brightRed: '#ffb1a8', brightGreen: '#c9edac',
    brightYellow: '#f2d99e', brightBlue: '#add2e4', brightMagenta: '#ddc0e0',
    brightCyan: '#a7e4d8', brightWhite: '#f0f3ed',
  },
})
const fit = new FitAddon()
term.loadAddon(fit)
term.loadAddon(new Unicode11Addon())
term.unicode.activeVersion = '11'
await document.fonts.load(`${term.options.fontSize}px "JetBrains Mono"`)
term.open(container)
term.textarea.setAttribute('aria-label', 'Shell command')
term.textarea.setAttribute('enterkeyhint', 'send')
await document.fonts.ready
fit.fit()

let worker
let timer
let generation = 0
let state = 'loading'
let cwd = '/home/lash/workspace'
let files = []
let nextId = 0
let activeId = 0
let completed = 0
let openingVisible = false
let agentBridge
let remoteCommand

const commands = 'alias awk basename cat cd chmod clear cp cut date dirname echo env exit export false find grep head help history jq ls lua mkdir mv printf pwd reset rm rmdir sed seq sleep sort source tail tee test touch tr true uname uniq unset wc which whoami xargs'.split(' ')
const editor = new LineEditor(term, { submit: run, interrupt, complete })
term.onData(data => {
  if (['\x03', '\x0c', '\t'].includes(data)) openingVisible = false
})

function setState(value) {
  state = value
  document.body.dataset.state = value
  status.textContent = { loading: 'starting', ready: 'local session', busy: 'running', failed: 'unavailable' }[value]
  stop.hidden = value !== 'busy'
  help.disabled = value !== 'ready'
}

function complete(before) {
  const match = before.match(/(?:^|[\s;|])([\w./-]*)$/)
  if (!match) return []
  const word = match[1]
  const isCommand = /(?:^|[;|])\s*[\w.-]*$/.test(before)
  const choices = (isCommand ? commands : files)
    .filter(name => name.startsWith(word) && /^[\w./-]+$/.test(name))
    .sort()
  return choices.length === 1
    ? [choices[0].slice(word.length) + (choices[0].endsWith('/') ? '' : ' ')]
    : choices
}

async function showHelp() {
  const description = 'Strands Shell is a Bourne-compatible shell that runs inside your own process. It includes grep, sed, jq, curl, find, and dozens of other commands without fork, exec, or raw system calls.'
  await editor.write([
    `${c.white}${wrapText(description, Math.min(72, term.cols))}${c.reset}`,
    '',
    `  ${c.green}ls${c.reset}                            look around`,
    `  ${c.green}cat README.txt${c.reset}                meet your workspace`,
    `  ${c.green}grep ERROR app.log | wc -l${c.reset}     count the errors`,
    `  ${c.green}jq '.[].name' projects.json${c.reset}    explore some JSON`,
    `  ${c.green}echo hello > note.txt${c.reset}         make something`,
    `  ${c.green}lua -e 'print(6 * 7)'${c.reset}          run a little Lua`,
    '',
    `${c.muted}↑ ↓ history   Tab complete   Shift+Enter newline`,
    `Ctrl+A/E start/end   Ctrl+U/K delete before/after`,
    `Ctrl+W delete word   Ctrl+L clear   Ctrl+C interrupt`,
    '',
    `clear     clear the screen`,
    `history   show this session's commands`,
    `reset     start a fresh workspace`,
    '',
    `Files live until reload or reset. Network is disabled.`,
    `Commands finish before output appears. No interactive`,
    `programs. Interrupting or the 5s limit resets files.${c.reset}`,
    '',
  ].join('\r\n') + '\r\n')
}

async function prompt() {
  await editor.prompt(displayPath(cwd))
  container.dataset.completed = String(completed)
  setState('ready')
}

async function output(text, color = '') {
  if (!text) return
  const safe = terminalText(text)
  await editor.write(`${color}${safe}${c.reset}${safe.endsWith('\n') ? '' : '\r\n'}`)
}

async function run(command) {
  openingVisible = false
  const trimmed = command.trim()
  if (!trimmed) return prompt()
  if (trimmed === 'clear') {
    await editor.clear()
    return prompt()
  }
  if (trimmed === 'help') {
    await showHelp()
    return prompt()
  }
  if (trimmed === 'history') {
    await output(editor.history.map((line, i) => `  ${String(i + 1).padStart(3)}  ${line}`).join('\n'))
    return prompt()
  }
  if (trimmed === 'reset' || trimmed === 'exit') {
    dialog.showModal()
    return prompt()
  }
  executeCommand(command)
}

function executeCommand(command) {
  setState('busy')
  result.textContent = ''
  activeId = ++nextId
  worker.postMessage({ id: activeId, command })
  const current = generation
  timer = setTimeout(() => {
    if (current !== generation) return
    startSession('5-second limit reached. The workspace was reset.')
  }, 5000)
}

function executeRemote(command) {
  return new Promise((resolve, reject) => {
    editor.enqueue(async () => {
      if (state !== 'ready' || dialog.open || remoteCommand) {
        reject(new Error('The browser is busy. Wait until the current command or dialog finishes.'))
        return
      }
      const saved = { text: editor.text.join(''), cursor: editor.cursor }
      remoteCommand = { resolve, reject, saved }
      openingVisible = false
      // Temporarily move the user's unfinished input out of the way; restore it
      // after the agent result. Remote commands never enter local input history.
      await editor.replace('')
      editor.active = false
      await editor.write(`${c.muted}[agent] ${c.reset}${plainText(command)}\r\n`)
      executeCommand(command)
    }).catch(reject)
  })
}

function rejectRemote(message) {
  const pending = remoteCommand
  remoteCommand = undefined
  pending?.reject(new Error(message))
}

function fail(message) {
  rejectRemote(message)
  agentBridge?.disconnect(false)
  clearTimeout(timer)
  worker?.terminate()
  editor.active = false
  setState('failed')
  editor.enqueue(() => output(`${message}\nUse “new session” to try again.`, c.red))
}

function startSession(message, clear = false) {
  rejectRemote(message || 'The browser workspace was reset.')
  agentBridge?.disconnect(false)
  const current = ++generation
  clearTimeout(timer)
  worker?.terminate()
  editor.active = false
  openingVisible = false
  setState('loading')
  result.textContent = ''
  cwd = '/home/lash/workspace'
  files = []
  editor.enqueue(async () => {
    if (clear) {
      await editor.clear()
      await editor.write(intro(term.cols))
      openingVisible = true
    }
    if (message) await output(message + '\n', c.muted)
  })
  if (!globalThis.WebAssembly?.Suspending || !WebAssembly.promising) {
    fail('This shell needs WebAssembly JSPI. Open it in a current Chrome or Edge browser.')
    return
  }
  const session = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  worker = session
  timer = setTimeout(() => fail('The shell took too long to start.'), 30000)
  session.onmessage = ({ data }) => {
    if (current !== generation) return
    if (data.type === 'result' && data.id !== activeId) return
    clearTimeout(timer)
    if (data.type === 'fatal') return fail(data.message)
    editor.enqueue(async () => {
      if (current !== generation) return
      cwd = data.cwd || cwd
      files = data.files || files
      if (data.type === 'result') {
        await output(data.stdout)
        await output(data.stderr, c.red)
        if (data.status !== 0) await output(`exit ${data.status}`, c.muted)
        completed++
        result.textContent = `${data.status === 0 ? '' : `exit ${data.status} · `}${data.elapsed < 1000 ? `${Math.round(data.elapsed)} ms` : `${(data.elapsed / 1000).toFixed(1)} s`}`
        result.dataset.failed = String(data.status !== 0)
      }
      const pending = remoteCommand
      remoteCommand = undefined
      await prompt()
      if (pending) {
        await editor.replace(pending.saved.text)
        editor.cursor = pending.saved.cursor
        await editor.render()
        pending.resolve({
          stdout: data.stdout, stderr: data.stderr, status: data.status,
          cwd: data.cwd, elapsed: data.elapsed,
        })
      }
      if (!dialog.open) term.focus()
    })
  }
  session.onerror = event => {
    if (current === generation) fail(event.message || 'Could not load the shell engine.')
  }
}

function interrupt() {
  if (state === 'busy') {
    editor.enqueue(() => editor.write('^C\r\n'))
    startSession('Command stopped. The workspace was reset.')
  }
}

help.addEventListener('click', () => editor.enqueue(async () => {
  if (state !== 'ready') return
  await editor.replace('help')
  await editor.accept()
  term.focus()
}))
document.querySelector('#clear').addEventListener('click', () => editor.enqueue(async () => {
  openingVisible = false
  await editor.clear()
  term.focus()
}))
document.querySelector('#reset').addEventListener('click', () => dialog.showModal())
stop.addEventListener('click', interrupt)
document.querySelector('#accessibility').addEventListener('click', event => {
  term.options.screenReaderMode = !term.options.screenReaderMode
  event.currentTarget.setAttribute('aria-pressed', String(term.options.screenReaderMode))
  event.currentTarget.textContent = `${term.options.screenReaderMode ? 'Disable' : 'Enable'} screen reader mode`
  term.focus()
})
dialog.addEventListener('submit', event => {
  if (event.submitter?.value === 'reset') {
    editor.history = []
    startSession('', true)
  }
})
dialog.addEventListener('close', () => {
  term.focus()
})

// Let pasted scripts be inspected and edited; only Enter executes them.
term.element.addEventListener('paste', event => {
  event.preventDefault()
  event.stopImmediatePropagation()
  const text = event.clipboardData?.getData('text/plain')
  if (text) editor.enqueue(() => editor.insert(text))
}, true)

new ResizeObserver(() => editor.enqueue(async () => {
  const previousSize = `${term.cols}:${term.rows}`
  const fontSize = smallScreen.matches ? 13 : 14
  if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize
  fit.fit()
  if (openingVisible && state !== 'failed' && previousSize !== `${term.cols}:${term.rows}`) {
    // Reflow the opening while preserving any command the user has started.
    const active = editor.active
    const draft = editor.text.join('')
    const cursor = editor.cursor
    editor.active = false
    await editor.clear()
    await editor.write(intro(term.cols))
    if (active) {
      await editor.prompt(displayPath(cwd))
      await editor.replace(draft)
      editor.cursor = cursor
    }
  }
  if (editor.active) await editor.render()
})).observe(container)
reducedMotion.addEventListener('change', () => {
  term.options.cursorBlink = !reducedMotion.matches
})
window.addEventListener('pagehide', () => {
  clearTimeout(timer)
  worker?.terminate()
})

agentBridge = createAgentBridge({ execute: executeRemote, cancel: interrupt, focus: () => term.focus() })
startSession(undefined, true)
term.focus()
