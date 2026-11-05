// The page's side of the agent bridge (bridge/bridge.mjs): a WebSocket to the
// bridge on 127.0.0.1, the queue of commands the agent sent, and the replies.
// It knows nothing about the shell; the page pulls commands with next() when
// it is idle and answers each with reply() or refuse().
//
//   bridge -> page  {type:'paired'} | {type:'run', id, command} | {type:'cancel', id}
//   page -> bridge  {type:'hello', token} | {type:'result', id, ...} | {type:'error', id, message}

export const defaultBridgePort = 7357

// Reads `#pair=<token>[&port=<port>]` from a URL hash. Returns null when absent.
export function readPairing(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('pair')
  if (!token) return null
  const requested = Number(params.get('port'))
  const port = Number.isInteger(requested) && requested >= 1024 && requested <= 65535 ? requested : defaultBridgePort
  return { token, port }
}

// Status values: connecting, connected, disconnected, rejected.
// onCommand() fires whenever a new command is queued.
export function connectAgent({ token, port, onStatus, onCommand, WebSocket = globalThis.WebSocket, retryDelay = 3000 }) {
  const queue = []
  let socket

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  function open() {
    const current = new WebSocket(`ws://127.0.0.1:${port}`)
    socket = current
    onStatus('connecting')
    current.onopen = () => current.send(JSON.stringify({ type: 'hello', token }))
    current.onmessage = ({ data }) => {
      let message
      try { message = JSON.parse(data) } catch { return }
      if (message.type === 'paired') onStatus('connected')
      if (message.type === 'cancel') {
        const index = queue.findIndex(job => job.id === message.id)
        if (index >= 0) queue.splice(index, 1)
      }
      if (message.type === 'run' && typeof message.command === 'string') {
        queue.push({ id: message.id, command: message.command })
        onCommand()
      }
    }
    current.onclose = ({ code }) => {
      queue.length = 0
      // 4000: another tab paired; 4001: wrong token. Neither improves by retrying.
      if (code === 4000 || code === 4001) return onStatus(code === 4001 ? 'rejected' : 'disconnected')
      onStatus('disconnected')
      setTimeout(open, retryDelay)
    }
  }

  open()
  return {
    // The oldest queued command, removed from the queue, or undefined.
    next: () => queue.shift(),
    get pending() { return queue.length },
    // Removes and returns every queued command.
    drain: () => queue.splice(0),
    reply(id, { stdout, stderr, status, cwd }) {
      send({ type: 'result', id, stdout, stderr, status, cwd })
    },
    refuse(id, message) {
      send({ type: 'error', id, message })
    },
  }
}
