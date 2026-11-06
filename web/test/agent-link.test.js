import assert from 'node:assert/strict'
import test from 'node:test'
import { connectAgent, readPairing } from '../agent-link.js'

// A WebSocket double: records sockets and sent messages; tests drive events.
function fakeWebSocket() {
  const sockets = []
  class FakeSocket {
    static OPEN = 1
    readyState = 0
    sent = []
    constructor(url) { this.url = url; sockets.push(this) }
    send(text) { this.sent.push(JSON.parse(text)) }
    open() { this.readyState = 1; this.onopen() }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }) }
    drop(code = 1006) { this.readyState = 3; this.onclose({ code }) }
  }
  return { FakeSocket, sockets }
}

function link(options = {}) {
  const { FakeSocket, sockets } = fakeWebSocket()
  const statuses = []
  let commands = 0
  const agent = connectAgent({
    token: 'tok', port: 7400, WebSocket: FakeSocket, retryDelay: 5,
    onStatus: status => statuses.push(status), onCommand: () => commands++, ...options,
  })
  return { agent, sockets, statuses, commands: () => commands }
}

test('readPairing reads the token and a valid port from the hash', () => {
  assert.equal(readPairing(''), null)
  assert.deepEqual(readPairing('#pair=abc'), { token: 'abc', port: 7357 })
  assert.deepEqual(readPairing('#pair=abc&port=40123'), { token: 'abc', port: 40123 })
  for (const port of ['80', '70000', '7400.5', 'x']) assert.equal(readPairing(`#pair=abc&port=${port}`).port, 7357)
})

test('pairs with the token, then queues commands in order', () => {
  const { agent, sockets, statuses, commands } = link()
  const [socket] = sockets
  assert.equal(socket.url, 'ws://127.0.0.1:7400')
  socket.open()
  assert.deepEqual(socket.sent, [{ type: 'hello', token: 'tok' }])
  socket.receive({ type: 'paired' })
  socket.receive({ type: 'run', id: 1, command: 'ls' })
  socket.receive({ type: 'run', id: 2, command: 'pwd' })
  socket.receive({ type: 'run', id: 3, command: 42 })
  assert.deepEqual(statuses, ['connecting', 'connected'])
  assert.equal(commands(), 2)
  assert.equal(agent.pending, 2)
  assert.deepEqual(agent.next(), { id: 1, command: 'ls' })
  agent.reply(1, { stdout: 'a', stderr: '', status: 0, cwd: '/', files: ['x'] })
  assert.deepEqual(socket.sent.at(-1), { type: 'result', id: 1, stdout: 'a', stderr: '', status: 0, cwd: '/' })
  agent.refuse(2, 'nope')
  assert.deepEqual(socket.sent.at(-1), { type: 'error', id: 2, message: 'nope' })
})

test('cancel removes a queued command; drain empties the queue', () => {
  const { agent, sockets } = link()
  sockets[0].open()
  for (const id of [1, 2, 3]) sockets[0].receive({ type: 'run', id, command: `echo ${id}` })
  sockets[0].receive({ type: 'cancel', id: 2 })
  assert.deepEqual(agent.drain().map(job => job.id), [1, 3])
  assert.equal(agent.pending, 0)
})

test('a dropped connection clears the queue and reconnects; rejections do not', async () => {
  const { agent, sockets, statuses } = link()
  sockets[0].open()
  sockets[0].receive({ type: 'run', id: 1, command: 'ls' })
  sockets[0].drop()
  assert.equal(agent.pending, 0)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(sockets.length, 2)
  sockets[1].open()
  sockets[1].drop(4001)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(sockets.length, 2)
  assert.deepEqual(statuses, ['connecting', 'disconnected', 'connecting', 'rejected'])
})

test('replies are dropped while the socket is not open', () => {
  const { agent, sockets } = link()
  agent.reply(1, { stdout: '', stderr: '', status: 0, cwd: '/' })
  assert.deepEqual(sockets[0].sent, [])
})

test('newToken makes distinct base64url tokens the bridge accepts', async () => {
  const { newToken } = await import('../agent-link.js')
  const a = newToken(), b = newToken()
  assert.match(a, /^[\w-]{32}$/)
  assert.notEqual(a, b)
})

test('agentPrompt carries the token and adds --page-url only off tryshell.sh', async () => {
  const { agentPrompt } = await import('../agent-link.js')
  const live = agentPrompt({ token: 'tok123', pageUrl: 'https://tryshell.sh/#pair=old' })
  assert.match(live, /npx -y github:ferdingler\/tryshell --http --token tok123\n/)
  assert.match(live, /Authorization: Bearer tok123' --data-binary @- <<'EOF'/)
  assert.doesNotMatch(live, /--page-url|#pair/)
  const local = agentPrompt({ token: 't', pageUrl: 'http://127.0.0.1:4173/?x=1' })
  assert.match(local, /--token t --page-url http:\/\/127\.0\.0\.1:4173\/\n/)
})
