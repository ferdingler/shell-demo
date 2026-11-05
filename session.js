// One shell engine at a time, in a worker (worker.js). The engine cannot be
// interrupted, so a command over the time limit, a stop, or a restart throws
// the worker away; the workspace goes with it.
//
//   start() -> Promise<{cwd, files}>   loads a fresh engine
//   run(command) -> Promise<{stdout, stderr, status, cwd, files, elapsed}>
//   stop(reason)                       discards the engine
//
// At most one command runs at a time; the engine cannot take overlapping calls.
// A pending start() or run() rejects with ResetError when stop() or start()
// replaces it, with LimitError when the command runs too long, and with a
// plain Error when the engine cannot load or crashes.

export const commandLimit = 5000
export const unsupportedMessage = 'This shell needs WebAssembly JSPI. Open it in a current Chrome or Edge browser.'

export class ResetError extends Error {}
export class LimitError extends Error {}

export function supportsEngine() {
  return Boolean(globalThis.WebAssembly?.Suspending && WebAssembly.promising)
}

export function createSession({ createWorker, startLimit = 30000, limit = commandLimit }) {
  let worker = null
  let pending = null
  let nextId = 0

  function settle(error, value) {
    if (!pending) return
    const { resolve, reject, timer } = pending
    pending = null
    clearTimeout(timer)
    if (error) reject(error)
    else resolve(value)
  }

  function discard(error) {
    worker?.terminate()
    worker = null
    settle(error)
  }

  function stop(reason = 'The workspace was reset.') {
    discard(new ResetError(reason))
  }

  function start() {
    stop()
    if (!supportsEngine()) return Promise.reject(new Error(unsupportedMessage))
    const current = createWorker()
    worker = current
    return new Promise((resolve, reject) => {
      pending = { id: null, resolve, reject, timer: setTimeout(() => discard(new Error('The shell took too long to start.')), startLimit) }
      current.onmessage = ({ data }) => {
        if (worker !== current) return
        if (data.type === 'fatal') return discard(new Error(data.message))
        if (data.type === 'ready' && pending?.id === null) return settle(null, { cwd: data.cwd, files: data.files })
        if (data.type === 'result' && pending?.id === data.id) settle(null, data)
      }
      current.onerror = event => {
        if (worker === current) discard(new Error(event.message || 'Could not load the shell engine.'))
      }
    })
  }

  function run(command) {
    if (!worker || pending) return Promise.reject(new Error('The shell is not ready for another command.'))
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => discard(new LimitError(`${limit / 1000}-second limit reached.`)), limit)
      pending = { id, resolve, reject, timer }
      worker.postMessage({ id, command })
    })
  }

  return { start, run, stop }
}
