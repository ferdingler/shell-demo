#!/usr/bin/env node
// Strands Shell agent bridge: lets a local AI agent run commands in the
// browser-tab shell. Zero dependencies; requires Node.js 22+.
//
//   local agent --stdio MCP--> bridge.mjs (127.0.0.1:7357) <--WebSocket-- page --> wasm shell
//
// Usage:
//   node bridge.mjs [--port 7357] [--page-url https://tryshell.sh/] [--origin <origin>]... [--open] [--http] [--token <token>]
//
// Without --port the bridge uses 7357, or any free port when 7357 is taken (for
// example by another agent session); the pairing URL then names the port.
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
//   bridge -> page  {type:'cancel', id}            (the call gave up; skip it if queued)
//   page -> bridge  {type:'result', id, stdout, stderr, status, cwd}
//   page -> bridge  {type:'error', id, message}   (the tab cannot run commands)
//
// HTTP mode (--http, prototype): instead of MCP on stdio, the bridge takes
// commands over HTTP so an agent can start it in the background and use curl:
//   curl -s http://127.0.0.1:7357/run -H 'Authorization: Bearer <token>' --data-binary 'ls'
// The reply is plain text: exit status, cwd, stdout, stderr. Requests must
// carry the pairing token, name 127.0.0.1 or localhost as Host (no DNS
// rebinding), and carry no Origin header (no web page can call it).
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
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'integer', description: 'Exit status' },
        cwd: { type: 'string', description: 'Working directory after the command' },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
      },
      required: ['status', 'cwd', 'stdout', 'stderr'],
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
const describe = output => [
  `exit status: ${output.status}`,
  `cwd: ${output.cwd}`,
  `stdout:\n${output.stdout}`,
  `stderr:\n${output.stderr}`,
].join('\n')
// Largest command body accepted over HTTP.
const bodyLimit = 1 << 20
// Thrown when the client cancels a request; MCP expects no reply to it.
const cancelled = Symbol('cancelled')
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

  // Gives up on a page command: the page skips it if it has not started.
  function abandon(id, error) {
    const call = pending.get(id)
    if (!call) return
    pending.delete(id)
    clearTimeout(call.timer)
    page?.send({ type: 'cancel', id })
    call.reject(error)
  }

  function runInPage(command, requestId) {
    return new Promise((resolve, reject) => {
      if (!page) return reject(new Error(`No browser tab is connected. Ask the user to open this pairing URL in Chrome or Edge: ${pairingUrl()}`))
      const id = ++nextId
      const timer = setTimeout(() => abandon(id, new Error(`The command did not finish within ${callTimeout / 1000}s. ` +
        'If it had not started yet, it will not run.')), callTimeout)
      pending.set(id, { resolve, reject, timer, requestId })
      page.send({ type: 'run', id, command })
    })
  }

  function cancelRequest(requestId) {
    for (const [id, call] of pending) if (call.requestId === requestId) abandon(id, cancelled)
  }

  async function callTool(name, input, requestId) {
    if (name === 'pairing_url') {
      return text(`${pairingUrl()}\n${page ? 'A browser tab is connected.' : 'No browser tab is connected yet.'}`)
    }
    if (name !== 'run_shell') throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 })
    if (typeof input?.command !== 'string') throw Object.assign(new Error('command must be a string'), { code: -32602 })
    try {
      const result = await runInPage(input.command, requestId)
      const output = { status: result.status, cwd: result.cwd, stdout: clip(result.stdout), stderr: clip(result.stderr) }
      return { ...text(describe(output)), structuredContent: output }
    } catch (error) {
      if (error === cancelled) throw error
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
          return rpcResult(id, await callTool(params?.name, params?.arguments, id))
        case 'notifications/cancelled':
          cancelRequest(params?.requestId)
          return null
        default:
          return isRequest ? rpcError(id, -32601, `Method not found: ${method}`) : null
      }
    } catch (error) {
      if (error === cancelled) return null
      return isRequest ? rpcError(id, error.code || -32603, error.message) : null
    }
  }

  // HTTP mode: POST /run with the command as the body; replies in plain text.
  async function handleHttp(request, response) {
    const reply = (code, body) => response.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }).end(body + '\n')
    const host = request.headers.host ?? ''
    if (request.headers.origin !== undefined || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      log(`rejected an HTTP request from origin ${request.headers.origin ?? '(none)'} for host ${host || '(none)'}`)
      return reply(403, 'Forbidden.')
    }
    const auth = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')
    if (!auth || !tokenMatches(auth[1])) return reply(401, 'Missing or wrong token: send Authorization: Bearer <token>.')
    const path = new URL(request.url, 'http://localhost').pathname
    if (path !== '/run') return reply(404, 'Not found. POST /run with the command as the body.')
    if (request.method !== 'POST') return reply(405, 'Use POST /run with the command as the body.')
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > bodyLimit) return reply(413, 'Command too large.')
      chunks.push(chunk)
    }
    // A heredoc ends with a newline; the tab would echo it as an empty line.
    const command = Buffer.concat(chunks).toString('utf8').replace(/\n+$/, '')
    if (!command.trim()) return reply(400, 'Empty command: send it as the request body.')
    try {
      const result = await runInPage(command)
      return reply(200, describe({ status: result.status, cwd: result.cwd, stdout: clip(result.stdout), stderr: clip(result.stderr) }))
    } catch (error) {
      return reply(page ? 504 : 503, error.message)
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
    handleHttp,
    pairingUrl,
    token,
    origins: () => [...allowed],
    get connected() { return page !== null },
    set port(value) { port = value },
  }
}

// ---- Script entry point: WebSocket on 127.0.0.1, MCP on stdio ----

function main() {
  const { values: args } = parseArgs({
    options: {
      port: { type: 'string' },
      'page-url': { type: 'string', default: 'https://tryshell.sh/' },
      origin: { type: 'string', multiple: true, default: [] },
      open: { type: 'boolean', default: false },
      http: { type: 'boolean', default: false },
      token: { type: 'string' },
    },
  })
  const log = (...parts) => console.error('[bridge]', ...parts)
  const requested = args.port === undefined ? defaultPort : Number(args.port)
  if (args.token !== undefined && !/^[\w-]{16,}$/.test(args.token)) {
    log('--token must be at least 16 characters of A-Z, a-z, 0-9, _ or -')
    process.exit(1)
  }
  const bridge = createBridge({ pageUrl: args['page-url'], origins: args.origin, token: args.token, log })

  const server = createServer(args.http ? bridge.handleHttp : (request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' }).end('Strands Shell agent bridge: WebSocket only.\n')
  })
  server.on('upgrade', bridge.upgrade)
  let fellBack = false
  server.on('error', error => {
    // A page holding its own token looks only on the default port, so --token
    // never falls back to another one.
    if (error.code === 'EADDRINUSE' && args.port === undefined && args.token === undefined && !fellBack) {
      log(`port ${requested} is in use; picking a free one`)
      fellBack = true
      return server.listen(0, '127.0.0.1')
    }
    log(`could not listen on 127.0.0.1:${requested}: ${error.message}`)
    process.exit(1)
  })
  server.listen(requested, '127.0.0.1')
  server.on('listening', () => {
    const { port } = server.address()
    bridge.port = port
    log(`listening on ws://127.0.0.1:${port}`)
    log(`allowed origins: ${bridge.origins().join(', ')}`)
    log(`pairing URL: ${bridge.pairingUrl()}`)
    if (args.http) log(`run commands: curl -s http://127.0.0.1:${port}/run -H 'Authorization: Bearer ${bridge.token}' --data-binary @- <<'EOF' ... EOF`)
    if (args.open) {
      const [command, ...rest] = process.platform === 'darwin' ? ['open']
        : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open']
      spawn(command, [...rest, bridge.pairingUrl()], { stdio: 'ignore', detached: true })
        .on('error', error => log(`could not open a browser: ${error.message}`))
        .unref()
    }
  })

  if (args.http) return
  // MCP over stdio: newline-delimited JSON-RPC 2.0. Only replies go to stdout.
  createInterface({ input: process.stdin }).on('line', async line => {
    const reply = await bridge.handleLine(line)
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n')
  }).on('close', () => process.exit(0))
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main()
