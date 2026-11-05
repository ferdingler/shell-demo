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
//   claude mcp add tryshell -- node /path/to/bridge.mjs --page-url <url>
//
// On start the bridge prints a pairing URL (<page-url>#pair=<token>) to stderr.
// Open it in Chrome or Edge, or ask the agent to call the `pairing_url` tool.
// The WebSocket listens on 127.0.0.1 only and accepts a page only when its
// Origin is the page URL's origin (or an extra --origin) and its first message
// carries the pairing token.
//
// Page protocol (JSON text frames):
//   page -> bridge  {type:'hello', token}
//   bridge -> page  {type:'paired'}
//   bridge -> page  {type:'run', id, command}
//   page -> bridge  {type:'result', id, stdout, stderr, status, cwd}
//   page -> bridge  {type:'error', id, message}   (the tab cannot run commands)
//
// The module also exports its parts (Socket, createBridge) for tests; it only
// starts listening when run as a script.

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const defaultPort = 7357

// ---- Minimal WebSocket server (RFC 6455, server side, small text frames) ----

// Wraps an upgraded stream. Accepts only masked, unfragmented frames up to
// 1 MiB, which is all a browser sends for small JSON messages.
export class Socket {
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

// ---- MCP tool definitions ----

const tools = [
  {
    name: 'run_shell',
    description: 'Run a command in the Strands Shell sandbox open in the user\'s browser tab. ' +
      'This is a Bourne-compatible shell with an in-memory workspace (grep, sed, jq, find, lua, ...), ' +
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

// MCP revisions this server implements, newest first. A client asking for one
// gets it back; any other request gets the newest, and the client decides.
const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

// Keep tool results small enough for an agent's context: the start and end of
// long output survive, with a note saying how much was dropped.
const outputLimit = 16000
export function clip(value = '') {
  if (value.length <= outputLimit) return value
  const head = value.slice(0, outputLimit * 0.75)
  const tail = value.slice(-outputLimit * 0.25)
  return `${head}\n[... ${value.length - head.length - tail.length} characters truncated ...]\n${tail}`
}

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], isError })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

// ---- The bridge: one paired page, MCP requests in, page commands out ----

// Everything except I/O wiring: pairing, the page protocol, and MCP handling.
// `handleLine` takes one line of MCP input and resolves to the reply (or null).
export function createBridge({
  pageUrl = 'https://tryshell.sh/',
  origins = [],
  token = randomBytes(24).toString('base64url'),
  callTimeout = 10000,
  log = () => {},
} = {}) {
  const allowed = new Set([new URL(pageUrl).origin, ...origins.map(origin => new URL(origin).origin)])
  let port = defaultPort
  let page = null
  let nextId = 0
  const pending = new Map()

  function pairingUrl() {
    const url = new URL(pageUrl)
    url.hash = `pair=${token}${port === defaultPort ? '' : `&port=${port}`}`
    return url.href
  }

  function tokenMatches(candidate) {
    const a = Buffer.from(String(candidate))
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  // Takes a Socket (or anything with send/close/onmessage/onclose) whose
  // origin was already checked, and pairs it once it presents the token.
  function accept(socket) {
    let paired = false
    const helloTimer = setTimeout(() => socket.close(4001, 'pairing timeout'), 5000)
    socket.onmessage = data => {
      let message
      try { message = JSON.parse(data) } catch { return socket.close(1007, 'invalid JSON') }
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

  // Completes the WebSocket handshake for an allowed origin, or refuses it.
  function upgrade(request, stream) {
    const origin = request.headers.origin
    const key = request.headers['sec-websocket-key']
    if (!allowed.has(origin) || !key || request.headers.upgrade?.toLowerCase() !== 'websocket') {
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
  }

  function runInPage(command) {
    return new Promise((resolve, reject) => {
      if (!page) return reject(new Error(`No browser tab is connected. Ask the user to open this pairing URL in Chrome or Edge: ${pairingUrl()}`))
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`The command did not finish within ${callTimeout / 1000}s.`))
      }, callTimeout)
      pending.set(id, { resolve, reject, timer })
      page.send({ type: 'run', id, command })
    })
  }

  async function callTool(name, input) {
    if (name === 'pairing_url') {
      return text(`${pairingUrl()}\n${page ? 'A browser tab is connected.' : 'No browser tab is connected yet.'}`)
    }
    if (name !== 'run_shell') throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 })
    if (typeof input?.command !== 'string') throw Object.assign(new Error('command must be a string'), { code: -32602 })
    try {
      const result = await runInPage(input.command)
      return text([
        `exit status: ${result.status}`,
        `cwd: ${result.cwd}`,
        `stdout:\n${clip(result.stdout)}`,
        `stderr:\n${clip(result.stderr)}`,
      ].join('\n'))
    } catch (error) {
      return text(error.message, true)
    }
  }

  async function handle({ id, method, params }) {
    const isRequest = id !== undefined && id !== null
    try {
      switch (method) {
        case 'initialize':
          return rpcResult(id, {
            protocolVersion: protocolVersions.includes(params?.protocolVersion) ? params.protocolVersion : protocolVersions[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'strands-shell-bridge', version: '0.1.0' },
            instructions: `Runs commands in the Strands Shell sandbox in the user's browser. If no tab is connected, give the user this URL: ${pairingUrl()}`,
          })
        case 'ping':
          return rpcResult(id, {})
        case 'tools/list':
          return rpcResult(id, { tools })
        case 'tools/call':
          return rpcResult(id, await callTool(params?.name, params?.arguments))
        default:
          return isRequest ? rpcError(id, -32601, `Method not found: ${method}`) : null
      }
    } catch (error) {
      return isRequest ? rpcError(id, error.code || -32603, error.message) : null
    }
  }

  async function handleLine(line) {
    if (!line.trim()) return null
    let message
    try { message = JSON.parse(line) } catch { return rpcError(null, -32700, 'Parse error') }
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // Stray responses are ignored; anything else with an id is invalid.
      const isResponse = message && ('result' in message || 'error' in message)
      return message?.id !== undefined && !isResponse ? rpcError(message.id ?? null, -32600, 'Invalid request') : null
    }
    return handle(message)
  }

  return {
    accept,
    upgrade,
    handleLine,
    pairingUrl,
    origins: () => [...allowed],
    get connected() { return page !== null },
    set port(value) { port = value },
  }
}

// ---- Script entry point: WebSocket on 127.0.0.1, MCP on stdio ----

function main() {
  const { values: args } = parseArgs({
    options: {
      port: { type: 'string', default: String(defaultPort) },
      'page-url': { type: 'string', default: 'https://tryshell.sh/' },
      origin: { type: 'string', multiple: true, default: [] },
      open: { type: 'boolean', default: false },
    },
  })
  const log = (...parts) => console.error('[bridge]', ...parts)
  const port = Number(args.port)
  const bridge = createBridge({ pageUrl: args['page-url'], origins: args.origin, log })
  bridge.port = port

  const server = createServer((request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' }).end('Strands Shell agent bridge: WebSocket only.\n')
  })
  server.on('upgrade', bridge.upgrade)
  server.on('error', error => {
    log(`could not listen on 127.0.0.1:${port}: ${error.message}`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    log(`listening on ws://127.0.0.1:${port}`)
    log(`allowed origins: ${bridge.origins().join(', ')}`)
    log(`pairing URL: ${bridge.pairingUrl()}`)
    if (args.open) {
      const [command, ...rest] = process.platform === 'darwin' ? ['open']
        : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open']
      spawn(command, [...rest, bridge.pairingUrl()], { stdio: 'ignore', detached: true })
        .on('error', error => log(`could not open a browser: ${error.message}`))
        .unref()
    }
  })

  // MCP over stdio: newline-delimited JSON-RPC 2.0. Only replies go to stdout.
  createInterface({ input: process.stdin }).on('line', async line => {
    const reply = await bridge.handleLine(line)
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n')
  }).on('close', () => process.exit(0))
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
