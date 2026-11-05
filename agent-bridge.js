// UI for the throwaway browser-agent experiment. Opening the panel opts in.
export function createAgentBridge({ execute, cancel, focus }) {
  const button = document.querySelector('#connect-agent')
  const dialog = document.querySelector('#agent-dialog')
  const status = document.querySelector('#agent-status')
  const config = document.querySelector('#agent-config')
  const session = document.querySelector('#agent-session-id')
  const approval = document.querySelector('#agent-approval')
  const name = document.querySelector('#agent-name')
  const details = document.querySelector('#agent-details')
  let ws
  let requestId
  let running = false
  const send = message => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }
  function disconnect(stopCommand = true) {
    const old = ws
    const wasRunning = running
    running = false
    ws = undefined
    old?.close()
    if (wasRunning && stopCommand) cancel()
    approval.hidden = true
    details.hidden = true
    button.textContent = 'connect agent'
    button.dataset.connected = 'false'
    status.textContent = 'Disconnected. Open this panel again to create a new connection.'
  }
  function connect() {
    status.textContent = 'Preparing a connection…'
    const url = new URL('/agent-session', location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const connection = new WebSocket(url)
    ws = connection
    connection.addEventListener('message', async ({ data }) => {
      if (ws !== connection) return
      let message
      try { message = JSON.parse(data) } catch { return }
      if (message.type === 'session') {
        session.textContent = message.sessionId
        config.textContent = JSON.stringify(message.config, null, 2)
        details.hidden = false
        status.textContent = 'Waiting for your agent. Ask it to call shell_connect.'
      } else if (message.type === 'approval') {
        requestId = message.requestId
        name.textContent = message.name
        approval.hidden = false
        if (!dialog.open) dialog.showModal()
        status.textContent = 'An agent is asking to use this workspace.'
        button.textContent = 'approve agent'
      } else if (message.type === 'attached') {
        approval.hidden = true
        status.textContent = `${message.name} is connected to this tab.`
        button.textContent = 'agent connected'
        button.dataset.connected = 'true'
        dialog.close()
        focus()
      } else if (message.type === 'detached') {
        approval.hidden = true
        button.textContent = 'connect agent'
        button.dataset.connected = 'false'
        status.textContent = message.reason
        const wasRunning = running
        running = false
        if (wasRunning) cancel()
      } else if (message.type === 'cancel') {
        const wasRunning = running
        running = false
        if (wasRunning) cancel()
      } else if (message.type === 'execute') {
        if (running) {
          send({ type: 'result', requestId: message.requestId, error: 'Browser is already running a command.' })
          return
        }
        running = true
        try {
          const result = await execute(message.command)
          if (ws === connection) send({ type: 'result', requestId: message.requestId, result })
        } catch (error) {
          if (ws === connection) send({ type: 'result', requestId: message.requestId, error: error.message })
        } finally { running = false }
      }
    })
    connection.addEventListener('close', () => {
      if (ws === connection) disconnect()
    })
    connection.addEventListener('error', () => {
      status.textContent = 'Relay unavailable. Run the agent prototype server to connect.'
    })
  }
  button.addEventListener('click', () => {
    if (!ws) connect()
    dialog.showModal()
  })
  document.querySelector('#agent-allow').addEventListener('click', () => {
    send({ type: 'approve', requestId })
  })
  document.querySelector('#agent-deny').addEventListener('click', () => {
    send({ type: 'deny', requestId })
  })
  document.querySelector('#agent-disconnect').addEventListener('click', () => {
    disconnect()
    dialog.close()
    focus()
  })
  document.querySelector('#agent-close').addEventListener('click', () => dialog.close())
  document.querySelector('#agent-copy').addEventListener('click', async event => {
    try {
      await navigator.clipboard.writeText(config.textContent)
      event.target.textContent = 'copied'
    } catch { event.target.textContent = 'select and copy below' }
  })
  dialog.addEventListener('close', focus)
  window.addEventListener('pagehide', disconnect)
  return { disconnect }
}
