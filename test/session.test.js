import assert from 'node:assert/strict'
import test from 'node:test'
import { LimitError, ResetError, createSession, unsupportedMessage } from '../session.js'

// A worker double: records posted commands; tests reply as the engine would.
function fakeWorkers() {
  const workers = []
  const createWorker = () => {
    const worker = {
      posted: [], terminated: false,
      postMessage(message) { this.posted.push(message) },
      terminate() { this.terminated = true },
      emit(data) { this.onmessage({ data }) },
    }
    workers.push(worker)
    return worker
  }
  return { workers, createWorker }
}

// Pretend the browser supports JSPI for the duration of a test.
function withEngine(t) {
  const saved = { Suspending: WebAssembly.Suspending, promising: WebAssembly.promising }
  WebAssembly.Suspending ??= function Suspending() {}
  WebAssembly.promising ??= () => {}
  t.after(() => Object.assign(WebAssembly, saved))
}

test('start resolves when the engine is ready; run returns its result', async t => {
  withEngine(t)
  const { workers, createWorker } = fakeWorkers()
  const session = createSession({ createWorker })
  const started = session.start()
  workers[0].emit({ type: 'ready', cwd: '/w', files: ['a'] })
  assert.deepEqual(await started, { cwd: '/w', files: ['a'] })
  const ran = session.run('ls')
  const [{ id, command }] = workers[0].posted
  assert.equal(command, 'ls')
  workers[0].emit({ type: 'result', id: id + 1, status: 9 })
  workers[0].emit({ type: 'result', id, status: 0, stdout: 'a\n' })
  assert.equal((await ran).stdout, 'a\n')
})

test('only one command runs at a time', async t => {
  withEngine(t)
  const { workers, createWorker } = fakeWorkers()
  const session = createSession({ createWorker })
  const started = session.start()
  workers[0].emit({ type: 'ready' })
  await started
  const first = session.run('sleep 1')
  await assert.rejects(session.run('ls'), /not ready/)
  assert.equal(workers[0].posted.length, 1)
  workers[0].emit({ type: 'result', id: workers[0].posted[0].id, status: 0 })
  await first
})

test('a command over the limit discards the engine with LimitError', async t => {
  withEngine(t)
  const { workers, createWorker } = fakeWorkers()
  const session = createSession({ createWorker, limit: 10 })
  const started = session.start()
  workers[0].emit({ type: 'ready' })
  await started
  await assert.rejects(session.run('while true; do :; done'), LimitError)
  assert.equal(workers[0].terminated, true)
})

test('stop and restart reject the pending call with ResetError', async t => {
  withEngine(t)
  const { workers, createWorker } = fakeWorkers()
  const session = createSession({ createWorker })
  const first = session.start()
  const second = session.start()
  await assert.rejects(first, ResetError)
  assert.equal(workers[0].terminated, true)
  workers[0].emit({ type: 'ready' })
  workers[1].emit({ type: 'ready', cwd: '/w' })
  assert.equal((await second).cwd, '/w')
  const ran = session.run('ls')
  session.stop('Command stopped.')
  await assert.rejects(ran, { name: 'Error', message: 'Command stopped.' })
})

test('a crash, load error, or slow start rejects with the reason', async t => {
  withEngine(t)
  const { workers, createWorker } = fakeWorkers()
  const session = createSession({ createWorker, startLimit: 10 })
  const crashed = session.start()
  workers[0].emit({ type: 'fatal', message: 'boom' })
  await assert.rejects(crashed, /boom/)
  const broken = session.start()
  workers[1].onerror({ message: '' })
  await assert.rejects(broken, /Could not load/)
  await assert.rejects(session.start(), /took too long/)
})

test('a browser without JSPI is refused before any worker loads', async () => {
  const { workers, createWorker } = fakeWorkers()
  await assert.rejects(createSession({ createWorker }).start(), { message: unsupportedMessage })
  assert.equal(workers.length, 0)
})
