// Throwaway experiment: an MCP client controls a shell running in a browser.
// Agents enter through an owner-only Unix socket (or SSH), never through HTTP.
import http from 'node:http'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, stat, unlink } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const port = Number(process.env.PORT || 4180)
const localOrigin = `http://127.0.0.1:${port}`
const origins = new Set([localOrigin, `http://localhost:${port}`])
if (process.env.SHELL_PUBLIC_ORIGIN) origins.add(new URL(process.env.SHELL_PUBLIC_ORIGIN).origin)
const hosts = new Set([...origins].map(origin => new URL(origin).host))
const socketPath = process.env.SHELL_BRIDGE_SOCKET ||
  join(tmpdir(), `strands-shell-agent-${process.getuid()}`, 'relay.sock')
const sessions = new Map()
const agentSockets = new Set()
const MAX_FRAME = 256 * 1024
const send = (socket, message) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png',
}

function settle(session, error, result) {
  const active = session.active
  if (!active) return
  session.active = null
  clearTimeout(active.timer)
  active.reply(error, result)
}

function detach(session, reason) {
  settle(session, reason)
  if (session.pending) {
    clearTimeout(session.pending.timer)
    session.pending.reply(reason)
    session.pending.agent.session = null
    session.pending = null
  }
  if (session.agent) {
    session.agent.session = null
    session.agent = null
  }
  send(session.ws, { type: 'detached', reason })
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (!hosts.has(req.headers.host)) {
    res.writeHead(403).end('Unrecognized host')
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: true, prototype: 'browser-agent-bridge' }))
    return
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, localOrigin).pathname)
    const dist = join(root, 'dist')
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(dist + sep)) throw new Error('invalid path')
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    res.writeHead(200, {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Content-Length': info.size, 'Cache-Control': 'no-store',
    })
    if (req.method === 'HEAD') res.end()
    else createReadStream(file).on('error', () => res.destroy()).pipe(res)
  } catch {
    res.writeHead(404).end('Not found')
  }
})
server.requestTimeout = 15_000
server.headersTimeout = 10_000
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/agent-session' || !hosts.has(req.headers.host) ||
      !origins.has(req.headers.origin) || sessions.size >= 32) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    return
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws))
})

wss.on('connection', ws => {
  const session = { id: randomUUID(), ws, pending: null, agent: null, active: null, alive: true }
  sessions.set(session.id, session)
  send(ws, {
    type: 'session', sessionId: session.id,
    config: { mcpServers: { 'strands-shell': {
      command: process.execPath,
      args: [join(root, 'prototypes/agent-bridge/mcp.mjs'), '--session', session.id],
      env: { SHELL_BRIDGE_SOCKET: socketPath },
    } } },
  })
  ws.on('pong', () => { session.alive = true })
  ws.on('error', () => {})
  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { ws.close(1008, 'Invalid JSON'); return }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'approve' && session.pending?.id === msg.requestId) {
      const pending = session.pending
      clearTimeout(pending.timer)
      session.pending = null
      session.agent = pending.agent
      send(ws, { type: 'attached', name: pending.name })
      pending.reply(null, { connected: true, sessionId: session.id })
    } else if (msg.type === 'deny' && session.pending?.id === msg.requestId) {
      detach(session, 'Connection declined in the browser.')
    } else if (msg.type === 'revoke') {
      if (session.active) send(ws, { type: 'cancel' })
      detach(session, 'Access revoked in the browser.')
    } else if (msg.type === 'result' && msg.requestId === session.active?.id) {
      if (typeof msg.error === 'string') {
        settle(session, msg.error.slice(0, 1000))
      } else if (msg.result && typeof msg.result.stdout === 'string' &&
          typeof msg.result.stderr === 'string' && Number.isInteger(msg.result.status) &&
          typeof msg.result.cwd === 'string') {
        settle(session, null, msg.result)
      } else {
        settle(session, 'Invalid browser result.')
      }
    }
  })
  ws.on('close', () => {
    detach(session, 'The browser session closed. Reconnect to a new session.')
    sessions.delete(session.id)
  })
})

function attach(agent, msg, reply) {
  if (agent.session) return reply('This client already has a connection or pending request.')
  const session = sessions.get(msg.sessionId)
  if (!session) return reply('Browser session not found. Open Connect agent in the browser first.')
  if (session.agent || session.pending) return reply('This browser already has an agent or a pending request.')
  const id = randomUUID()
  const name = typeof msg.name === 'string' ? msg.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) : 'MCP agent'
  agent.session = session
  session.pending = {
    id, name, agent, reply,
    timer: setTimeout(() => detach(session, 'Browser approval timed out.'), 90_000),
  }
  send(session.ws, { type: 'approval', requestId: id, name })
}

function execute(agent, msg, reply) {
  const session = agent.session
  if (!session || session.agent !== agent) return reply('Connect first and approve the request in the browser.')
  if (session.active) return reply('A command is already running. Wait for its result.')
  if (typeof msg.command !== 'string' || !msg.command.trim() ||
      Buffer.byteLength(msg.command) > 64 * 1024) return reply('Command must contain 1–65536 bytes.')
  const id = randomUUID()
  session.active = {
    id, reply,
    timer: setTimeout(() => {
      send(session.ws, { type: 'cancel' })
      detach(session, 'Browser execution timed out; access revoked. Check that the tab is active.')
    }, 10_000),
  }
  send(session.ws, { type: 'execute', requestId: id, command: msg.command })
}

// Filesystem permissions authenticate access to this socket. Browser approval
// authorizes one live socket connection. Session IDs only route; they are not keys.
const agentServer = net.createServer(socket => {
  if (agentSockets.size >= 32) { socket.end(); return }
  agentSockets.add(socket)
  const agent = { socket, session: null }
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(); return }
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let msg
      try { msg = JSON.parse(line) } catch { socket.destroy(); return }
      if (!msg || !Number.isSafeInteger(msg.id)) { socket.destroy(); return }
      const reply = (error, result) => {
        if (!socket.destroyed) socket.write(JSON.stringify({ id: msg.id, error: error || undefined, result }) + '\n')
      }
      if (msg.method === 'attach') attach(agent, msg, reply)
      else if (msg.method === 'exec') execute(agent, msg, reply)
      else if (msg.method === 'status') reply(null, {
        connected: agent.session?.agent === agent,
        sessionId: agent.session?.id || null,
      })
      else if (msg.method === 'disconnect') {
        if (agent.session) {
          if (agent.session.active) send(agent.session.ws, { type: 'cancel' })
          detach(agent.session, 'Agent disconnected.')
        }
        reply(null, { connected: false })
      } else reply('Unknown method.')
    }
  })
  socket.on('close', () => {
    agentSockets.delete(socket)
    if (agent.session) {
      if (agent.session.active) send(agent.session.ws, { type: 'cancel' })
      detach(agent.session, 'Agent disconnected.')
    }
  })
})

await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
const directory = await lstat(dirname(socketPath))
if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
  throw new Error('The relay socket directory must be owned by you with mode 0700.')
}
// Do not unlink another running relay's socket.
try {
  await lstat(socketPath)
  throw new Error(`Socket already exists: ${socketPath}. Stop the old relay before restarting.`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
await new Promise((resolve, reject) => {
  agentServer.once('error', reject)
  agentServer.listen(socketPath, resolve)
})
await chmod(socketPath, 0o600)
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
} catch (error) {
  agentServer.close()
  await unlink(socketPath).catch(() => {})
  throw error
}
const heartbeat = setInterval(() => {
  for (const session of sessions.values()) {
    if (!session.alive) session.ws.terminate()
    else { session.alive = false; session.ws.ping() }
  }
}, 15_000)
heartbeat.unref()
console.log(`Browser agent prototype: ${localOrigin}\nMCP relay socket: ${socketPath}`)
let closing = false
async function close() {
  if (closing) return
  closing = true
  clearInterval(heartbeat)
  for (const session of sessions.values()) session.ws.terminate()
  for (const socket of agentSockets) socket.destroy()
  wss.close()
  server.closeAllConnections()
  server.close()
  agentServer.close()
  await unlink(socketPath).catch(() => {})
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
