import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Socket, clip, createBridge } from '../bridge/bridge.mjs'

// A stand-in for an upgraded TCP stream that records what the socket writes.
class Stream extends EventEmitter {
  written = []
  ended = false
  write(chunk) { this.written.push(Buffer.from(chunk)) }
  end() { this.ended = true }
  destroy() {}
}

// Encodes a client frame the way a browser does: masked, final.
function clientFrame(opcode, payload, { masked = true, fin = true } = {}) {
  const data = Buffer.from(payload)
  const length = data.length
  const header = length < 126 ? Buffer.from([opcode | (fin ? 0x80 : 0), (masked ? 0x80 : 0) | length])
    : length < 65536 ? Buffer.from([opcode | 0x80, 0x80 | 126, length >> 8, length & 0xff])
      : Buffer.concat([Buffer.from([opcode | 0x80, 0x80 | 127]), (() => {
        const size = Buffer.alloc(8)
        size.writeBigUInt64BE(BigInt(length))
        return size
      })()])
  if (!masked) return Buffer.concat([header, data])
  const mask = Buffer.from([1, 2, 3, 4])
  return Buffer.concat([header, mask, data.map((byte, i) => byte ^ mask[i & 3])])
}

// Decodes one unmasked server frame.
function serverFrame(buffer) {
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) [length, offset] = [buffer.readUInt16BE(2), 4]
  if (length === 127) [length, offset] = [Number(buffer.readBigUInt64BE(2)), 10]
  return { opcode: buffer[0] & 0x0f, payload: buffer.subarray(offset, offset + length) }
}

function socketWithMessages() {
  const stream = new Stream()
  const socket = new Socket(stream)
  const messages = []
  socket.onmessage = text => messages.push(text)
  return { stream, socket, messages }
}

test('text frames of every length encoding are unmasked and delivered', () => {
  const { stream, messages } = socketWithMessages()
  for (const size of [5, 300, 70000]) stream.emit('data', clientFrame(0x1, 'x'.repeat(size)))
  assert.deepEqual(messages.map(text => text.length), [5, 300, 70000])
})

test('a frame split across chunks is delivered once it is complete', () => {
  const { stream, messages } = socketWithMessages()
  const frame = clientFrame(0x1, '{"type":"hello"}')
  stream.emit('data', frame.subarray(0, 3))
  assert.deepEqual(messages, [])
  stream.emit('data', frame.subarray(3))
  assert.deepEqual(messages, ['{"type":"hello"}'])
})

test('ping gets a pong with the same payload', () => {
  const { stream } = socketWithMessages()
  stream.emit('data', clientFrame(0x9, 'beat'))
  const pong = serverFrame(stream.written[0])
  assert.equal(pong.opcode, 0xa)
  assert.equal(pong.payload.toString(), 'beat')
})

test('unmasked or fragmented frames close the connection with 1002', () => {
  for (const options of [{ masked: false }, { fin: false }]) {
    const { stream, socket } = socketWithMessages()
    stream.emit('data', clientFrame(0x1, 'hi', options))
    const close = serverFrame(stream.written[0])
    assert.equal(close.opcode, 0x8)
    assert.equal(close.payload.readUInt16BE(0), 1002)
    assert.equal(socket.closed, true)
  }
})

test('sent messages use the right length encoding', () => {
  const { stream, socket } = socketWithMessages()
  for (const size of [10, 1000, 70000]) socket.send({ text: 'y'.repeat(size) })
  assert.deepEqual(stream.written.map(frame => JSON.parse(serverFrame(frame).payload).text.length), [10, 1000, 70000])
})

const rpc = (bridge, message) => bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', ...message }))

test('initialize negotiates a supported protocol version', async () => {
  const bridge = createBridge()
  assert.equal((await rpc(bridge, { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).result.protocolVersion, '2025-03-26')
  assert.equal((await rpc(bridge, { id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).result.protocolVersion, '2025-11-25')
})

test('notifications and stray responses get no reply; bad input gets JSON-RPC errors', async () => {
  const bridge = createBridge()
  assert.equal(await rpc(bridge, { method: 'notifications/initialized' }), null)
  assert.equal(await rpc(bridge, { method: 'notifications/unknown' }), null)
  assert.equal(await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, result: {} })), null)
  assert.equal(await bridge.handleLine(''), null)
  assert.equal((await bridge.handleLine('{nope')).error.code, -32700)
  assert.equal((await bridge.handleLine(JSON.stringify({ id: 3 }))).error.code, -32600)
  assert.equal((await rpc(bridge, { id: 4, method: 'nope' })).error.code, -32601)
  assert.equal((await rpc(bridge, { id: 5, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602)
})

test('the pairing URL carries the token and a non-default port', () => {
  const bridge = createBridge({ pageUrl: 'https://example.test/shell/', token: 'abc' })
  assert.equal(bridge.pairingUrl(), 'https://example.test/shell/#pair=abc')
  bridge.port = 7400
  assert.equal(bridge.pairingUrl(), 'https://example.test/shell/#pair=abc&port=7400')
  assert.deepEqual(createBridge({ pageUrl: 'https://a.test/x', origins: ['https://b.test/'] }).origins(), ['https://a.test', 'https://b.test'])
})

// A paired page double: records what the bridge sends and lets the test reply.
function fakePage(bridge, token) {
  const page = { sent: [], closed: null, send(message) { this.sent.push(message) }, close(code) { this.closed = code; this.onclose() } }
  bridge.accept(page)
  page.onmessage(JSON.stringify({ type: 'hello', token }))
  return page
}

test('run_shell forwards to the paired page and formats its result', async () => {
  const bridge = createBridge({ token: 'secret' })
  const page = fakePage(bridge, 'secret')
  assert.deepEqual(page.sent[0], { type: 'paired' })
  const reply = rpc(bridge, { id: 1, method: 'tools/call', params: { name: 'run_shell', arguments: { command: 'echo hi' } } })
  const run = page.sent[1]
  assert.equal(run.command, 'echo hi')
  page.onmessage(JSON.stringify({ type: 'result', id: run.id, stdout: 'hi\n', stderr: '', status: 0, cwd: '/w' }))
  const { result } = await reply
  assert.equal(result.isError, false)
  assert.equal(result.content[0].text, 'exit status: 0\ncwd: /w\nstdout:\nhi\n\nstderr:\n')
})

test('a wrong token is rejected and a newer page replaces the older one', () => {
  const bridge = createBridge({ token: 'secret' })
  const wrong = fakePage(bridge, 'guess')
  assert.equal(wrong.closed, 4001)
  assert.equal(bridge.connected, false)
  const first = fakePage(bridge, 'secret')
  const second = fakePage(bridge, 'secret')
  assert.equal(first.closed, 4000)
  assert.equal(second.closed, null)
  assert.equal(bridge.connected, true)
})

test('a page error or disconnect fails the call with a message', async () => {
  const bridge = createBridge({ token: 't' })
  const page = fakePage(bridge, 't')
  const call = command => rpc(bridge, { id: 1, method: 'tools/call', params: { name: 'run_shell', arguments: { command } } })
  const refused = call('ls')
  page.onmessage(JSON.stringify({ type: 'error', id: page.sent.at(-1).id, message: 'tab unavailable' }))
  assert.deepEqual((await refused).result, { content: [{ type: 'text', text: 'tab unavailable' }], isError: true })
  const dropped = call('ls')
  page.close(1001)
  assert.match((await dropped).result.content[0].text, /disconnected/)
  assert.match((await call('ls')).result.content[0].text, /No browser tab is connected.*#pair=t/)
})

test('long output keeps its start and end', () => {
  assert.equal(clip('short'), 'short')
  const clipped = clip('a'.repeat(20000) + 'END')
  assert.ok(clipped.length < 16100)
  assert.match(clipped, /^a+\n\[\.\.\. \d+ characters truncated \.\.\.\]\na+END$/)
})
