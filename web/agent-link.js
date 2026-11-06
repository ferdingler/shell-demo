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

// A fresh pairing token: 24 random bytes, base64url, as the bridge makes them.
export function newToken(crypto = globalThis.crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// The prompt a visitor pastes into a local agent. The agent starts the bridge
// with this page's token, and the page, already waiting on the default port,
// pairs as soon as it is up. The quoted heredoc passes commands through the
// agent's own shell untouched. `pageUrl` is added only off tryshell.sh, whose
// origin the bridge allows by default.
export function agentPrompt({ token, pageUrl }) {
  const page = new URL(pageUrl)
  page.hash = ''
  page.search = ''
  const flag = page.origin === 'https://tryshell.sh' ? '' : ` --page-url ${page.href}`
  return [
    `I have Strands Shell open in my browser at ${page.href}. Connect to it and drive it for me.`,
    '',
    '1. Start the bridge in the background and leave it running:',
    '',
    `   npx -y github:ferdingler/tryshell --http --token ${token}${flag}`,
    '',
    '2. Run each shell command in my tab like this. The quoted heredoc passes the command through your shell untouched:',
    '',
    `   curl -s http://127.0.0.1:${defaultBridgePort}/run -H 'Authorization: Bearer ${token}' --data-binary @- <<'EOF'`,
    '   ls -la',
    '   EOF',
    '',
    'It is a sandboxed, Bourne-compatible shell with an in-memory workspace; I can watch every command in my tab. Start by exploring what it can do.',
  ].join('\n')
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
