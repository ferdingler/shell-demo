#!/usr/bin/env node
// Strands Shell agent bridge: lets a local AI agent run commands in the
// browser-tab shell. Zero dependencies; requires Node.js 22+.
//
//   local agent --stdio MCP--> bridge.mjs (127.0.0.1:7357) <--WebSocket-- page --> wasm shell
//
// Usage:
//   node bridge.mjs [--port 7357] [--page-url https://tryshell.sh/] [--origin <origin>]... [--open]
//
// Claude Code:
//   claude mcp add tryshell -- node /path/to/bridge.mjs --page-url <url> --origin <origin>
//
// On start the bridge prints a pairing URL (<page-url>#pair=<token>) to stderr.
// Open it in Chrome or Edge, or ask the agent to call the `pairing_url` tool.
// The WebSocket listens on 127.0.0.1 only and accepts a page only when its
// Origin is allowlisted and its first message carries the pairing token.
//
// Page protocol (JSON text frames):
//   page -> bridge  {type:'hello', token}
//   bridge -> page  {type:'paired'}
//   bridge -> page  {type:'run', id, command}
//   page -> bridge  {type:'result', id, stdout, stderr, status, cwd}
//   page -> bridge  {type:'error', id, message}   (the tab cannot run commands)

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '7357' },
    'page-url': { type: 'string', default: 'https://tryshell.sh/' },
    origin: { type: 'string', multiple: true, default: [] },
    open: { type: 'boolean', default: false },
  },
})
const port = Number(args.port)
const origins = new Set([
  'https://tryshell.sh',
  'http://127.0.0.1:4173', 'http://localhost:4173',
  'http://127.0.0.1:5173', 'http://localhost:5173',
  ...args.origin.map(origin => origin.replace(/\/$/, '')),
])
const token = randomBytes(24).toString('base64url')
const pageUrl = new URL(args['page-url'])
pageUrl.hash = `pair=${token}${port === 7357 ? '' : `&port=${port}`}`
const pairingUrl = pageUrl.href
const callTimeout = 10000
const log = (...parts) => console.error('[bridge]', ...parts)

// ---- Minimal WebSocket server (RFC 6455, server side, small text frames) ----

class Socket {
  constructor(stream) {
    this.stream = stream
    this.buffer = Buffer.alloc(0)
    this.onmessage = () => {}
    this.onclose = () => {}
    this.closed = false
    stream.on('data', chunk => this.receive(chunk))
    stream.on('close', () => this.finish())
    stream.on('error', () => this.finish())
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const fin = this.buffer[0] & 0x80
      const opcode = this.buffer[0] & 0x0f
      const masked = this.buffer[1] & 0x80
      let length = this.buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (!masked || !fin || length > 1 << 20) return this.close(1002, 'unsupported frame')
      if (this.buffer.length < offset + 4 + length) return
      const mask = this.buffer.subarray(offset, offset + 4)
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      this.buffer = this.buffer.subarray(offset + 4 + length)
      if (opcode === 0x1) this.onmessage(payload.toString('utf8'))
      else if (opcode === 0x8) return this.close(1000)
      else if (opcode === 0x9) this.frame(0xa, payload)
      else if (opcode !== 0xa) return this.close(1003, 'text frames only')
    }
  }

  frame(opcode, payload) {
    if (this.closed) return
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536 ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => {
          const size = Buffer.alloc(8)
          size.writeBigUInt64BE(BigInt(payload.length))
          return size
        })()])
    this.stream.write(Buffer.concat([header, payload]))
  }

  send(message) {
    this.frame(0x1, Buffer.from(JSON.stringify(message)))
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
    payload.writeUInt16BE(code)
    payload.write(reason, 2)
    this.frame(0x8, payload)
    this.stream.end()
    this.finish()
  }

  finish() {
    if (this.closed) return
    this.closed = true
    this.stream.destroy()
    this.onclose()
  }
}

// ---- Page pairing and command dispatch ----

let page = null
let nextId = 0
const pending = new Map()

function tokenMatches(candidate) {
  const a = Buffer.from(String(candidate))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function accept(socket) {
  let paired = false
  const helloTimer = setTimeout(() => socket.close(4001, 'pairing timeout'), 5000)
  socket.onmessage = text => {
    let message
    try { message = JSON.parse(text) } catch { return socket.close(1007, 'invalid JSON') }
    if (!paired) {
      clearTimeout(helloTimer)
      if (message?.type !== 'hello' || !tokenMatches(message.token)) {
        log('rejected a page with a wrong pairing token')
        return socket.close(4001, 'invalid pairing token')
      }
      paired = true
      if (page) page.close(4000, 'replaced by a newer page')
      page = socket
      socket.send({ type: 'paired' })
      log('page connected')
      return
    }
    if ((message?.type === 'result' || message?.type === 'error') && pending.has(message.id)) {
      const call = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(call.timer)
      if (message.type === 'error') call.reject(new Error(String(message.message)))
      else call.resolve(message)
    }
  }
  socket.onclose = () => {
    clearTimeout(helloTimer)
    if (page !== socket) return
    page = null
    log('page disconnected')
    for (const [id, call] of pending) {
      clearTimeout(call.timer)
      call.reject(new Error('The browser tab disconnected before the command finished.'))
      pending.delete(id)
    }
  }
}

function runInPage(command) {
  return new Promise((resolve, reject) => {
    if (!page) return reject(new Error(`No browser tab is connected. Ask the user to open this pairing URL in Chrome or Edge: ${pairingUrl}`))
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`The command did not finish within ${callTimeout / 1000}s.`))
    }, callTimeout)
    pending.set(id, { resolve, reject, timer })
    page.send({ type: 'run', id, command })
  })
}

const server = createServer((request, response) => {
  response.writeHead(426, { 'content-type': 'text/plain' }).end('Strands Shell agent bridge: WebSocket only.\n')
})
server.on('upgrade', (request, stream) => {
  const origin = request.headers.origin
  const key = request.headers['sec-websocket-key']
  if (!origins.has(origin) || !key || request.headers.upgrade?.toLowerCase() !== 'websocket') {
    log(`rejected a connection from origin ${origin ?? '(none)'}`)
    stream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  const acceptKey = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  stream.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '', '',
  ].join('\r\n'))
  accept(new Socket(stream))
})
server.on('error', error => {
  log(`could not listen on 127.0.0.1:${port}: ${error.message}`)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  log(`listening on ws://127.0.0.1:${port}`)
  log(`allowed origins: ${[...origins].join(', ')}`)
  log(`pairing URL: ${pairingUrl}`)
  if (args.open) {
    const [command, ...rest] = process.platform === 'darwin' ? ['open']
      : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open']
    spawn(command, [...rest, pairingUrl], { stdio: 'ignore', detached: true })
      .on('error', error => log(`could not open a browser: ${error.message}`))
      .unref()
  }
})

// ---- MCP over stdio (newline-delimited JSON-RPC 2.0) ----

const tools = [
  {
    name: 'run_shell',
    description: 'Run a command in the Strands Shell sandbox open in the user\'s browser tab. ' +
      'This is a Bourne-compatible shell with an in-memory workspace (grep, sed, jq, awk, lua, ...), ' +
      'no network access, and no access to the user\'s machine or files. State persists between calls ' +
      'until the tab reloads or resets; commands are limited to about 5 seconds. ' +
      'The user sees each command in their terminal.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command or script to run' } },
      required: ['command'],
    },
  },
  {
    name: 'pairing_url',
    description: 'Get the URL the user must open in Chrome or Edge to connect their browser shell to this agent.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], isError })

async function callTool(name, input) {
  if (name === 'pairing_url') {
    return text(`${pairingUrl}\n${page ? 'A browser tab is connected.' : 'No browser tab is connected yet.'}`)
  }
  if (name !== 'run_shell') throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 })
  if (typeof input?.command !== 'string') throw Object.assign(new Error('command must be a string'), { code: -32602 })
  try {
    const result = await runInPage(input.command)
    return text([
      `exit status: ${result.status}`,
      `cwd: ${result.cwd}`,
      `stdout:\n${result.stdout || ''}`,
      `stderr:\n${result.stderr || ''}`,
    ].join('\n'))
  } catch (error) {
    return text(error.message, true)
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

async function handle(message) {
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'strands-shell-bridge', version: '0.1.0' },
          instructions: `Runs commands in the Strands Shell sandbox in the user's browser. If no tab is connected, give the user this URL: ${pairingUrl}`,
        })
      case 'ping':
        return reply(id, {})
      case 'tools/list':
        return reply(id, { tools })
      case 'tools/call':
        return reply(id, await callTool(params?.name, params?.arguments))
      default:
        if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
    }
  } catch (error) {
    if (isRequest) replyError(id, error.code || -32603, error.message)
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return replyError(null, -32700, 'Parse error') }
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined && !('result' in message) && !('error' in message)) replyError(message.id ?? null, -32600, 'Invalid request')
    return
  }
  handle(message)
}).on('close', () => process.exit(0))
