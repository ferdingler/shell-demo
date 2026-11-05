import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { LineEditor } from './line-editor.js'
import { intro } from './intro.js'
import { complete } from './completion.js'
import { connectAgent, readPairing } from './agent-link.js'
import { LimitError, ResetError, createSession } from './session.js'
import { colors as c, displayPath, plainText, terminalText, wrapText } from './terminal-text.js'
import './style.css'

const container = document.querySelector('#terminal')
const status = document.querySelector('#runtime-status')
const result = document.querySelector('#last-result')
const stop = document.querySelector('#stop')
const help = document.querySelector('#help')
const dialog = document.querySelector('#reset-dialog')
const agentStatus = document.querySelector('#agent-status')
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

const session = createSession({
  createWorker: () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
})
// Bumped by every restart, so work queued for an older engine is dropped.
let generation = 0
let state = 'loading'
let cwd = '/home/lash/workspace'
let files = []
let completed = 0
let openingVisible = false
// Commands from a paired local agent; they run one at a time when the shell is idle.
let agent = null
let agentJob = null
let agentDraft = null
let failure = ''

const editor = new LineEditor(term, { submit: run, interrupt, complete: before => complete(before, files) })
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
    `agent     node bridge/bridge.mjs pairs a local AI agent`,
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
  pumpAgent()
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
  execute(command)
}

// Runs a command in the engine and shows the result; `job` is the agent
// command it answers, if any. Not awaited: the editor stays responsive.
async function execute(command, job = null) {
  const current = generation
  setState('busy')
  result.textContent = ''
  let data
  try {
    data = await session.run(command)
  } catch (error) {
    if (error instanceof LimitError) return startSession(`${error.message} The workspace was reset.`)
    if (error instanceof ResetError) return // a stop or new session already took over
    return fail(error.message)
  }
  editor.enqueue(async () => {
    if (current !== generation) return
    cwd = data.cwd || cwd
    files = data.files || files
    await output(data.stdout)
    await output(data.stderr, c.red)
    if (data.status !== 0) await output(`exit ${data.status}`, c.muted)
    completed++
    result.textContent = `${data.status === 0 ? '' : `exit ${data.status} · `}${data.elapsed < 1000 ? `${Math.round(data.elapsed)} ms` : `${(data.elapsed / 1000).toFixed(1)} s`}`
    result.dataset.failed = String(data.status !== 0)
    if (job) {
      agent.reply(job.id, data)
      agentJob = null
    }
    await settle()
  })
}

// Shows the prompt once the shell is idle, restoring the human's draft after
// the agent's commands are done.
async function settle() {
  await prompt()
  if (!agentJob && agentDraft !== null && !agent?.pending) {
    await editor.replace(agentDraft)
    agentDraft = null
  }
  if (!dialog.open) term.focus()
}

function fail(message) {
  session.stop()
  editor.active = false
  failure = message
  setState('failed')
  for (const job of [agentJob, ...(agent?.drain() ?? [])]) if (job) refuseAgent(job.id)
  agentJob = null
  editor.enqueue(() => output(`${message}\nUse “new session” to try again.`, c.red))
}

function startSession(message, clear = false) {
  const current = ++generation
  editor.active = false
  openingVisible = false
  failure = ''
  setState('loading')
  result.textContent = ''
  cwd = '/home/lash/workspace'
  files = []
  if (agentJob) {
    agent.reply(agentJob.id, { stdout: '', stderr: message || 'The workspace was reset.', status: 130, cwd })
    agentJob = null
  }
  editor.enqueue(async () => {
    if (clear) {
      await editor.clear()
      await editor.write(intro(term.cols))
      openingVisible = true
    }
    if (message) await output(message + '\n', c.muted)
  })
  session.start().then(ready => editor.enqueue(async () => {
    if (current !== generation) return
    cwd = ready.cwd || cwd
    files = ready.files || files
    await settle()
  }), error => {
    if (current === generation && !(error instanceof ResetError)) fail(error.message)
  })
}

function interrupt() {
  if (state === 'busy') {
    editor.enqueue(() => editor.write('^C\r\n'))
    startSession('Command stopped. The workspace was reset.')
  }
}

function setAgentStatus(value) {
  agentStatus.hidden = false
  agentStatus.dataset.state = value
  agentStatus.lastChild.textContent = `agent ${value}`
}

// Tell the agent right away when this tab cannot run commands, instead of
// letting the call wait for the bridge's timeout.
function refuseAgent(id) {
  agent?.refuse(id, `The shell in the user's browser tab is unavailable: ${failure} ` +
    'Ask the user to open the pairing URL in a current Chrome or Edge browser, or to start a new session.')
}

// Run the next agent command through the same worker path as typed input,
// echoed at a labeled prompt. The human's unfinished draft is restored after.
function pumpAgent() {
  editor.enqueue(async () => {
    if (agentJob || state !== 'ready' || !editor.active || dialog.open || !agent?.pending) return
    agentJob = agent.next()
    if (agentDraft === null) agentDraft = editor.text.join('')
    openingVisible = false
    editor.path = `${c.blue}agent ›${c.reset} ${c.green}${displayPath(cwd)}`
    await editor.replace(plainText(agentJob.command))
    await editor.write('\r\n')
    editor.active = false
    execute(agentJob.command, agentJob)
  })
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
  pumpAgent()
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
window.addEventListener('pagehide', () => session.stop())

startSession(undefined, true)
term.focus()

const pairing = readPairing(location.hash)
if (pairing) {
  history.replaceState(null, '', location.pathname + location.search)
  agent = connectAgent({
    ...pairing,
    onStatus: setAgentStatus,
    onCommand() {
      if (state !== 'failed') return pumpAgent()
      for (const job of agent.drain()) refuseAgent(job.id)
    },
  })
}
