import { FolderMailbox } from './mailbox.js'

export function createFolderAgent({ execute, cancel, focus }) {
  const button = document.querySelector('#connect-agent')
  const dialog = document.querySelector('#agent-dialog')
  const drop = document.querySelector('#agent-drop')
  const choose = document.querySelector('#agent-choose')
  const allow = document.querySelector('#agent-allow')
  const status = document.querySelector('#agent-status')
  const connected = document.querySelector('#agent-connected')
  const prompt = document.querySelector('#agent-prompt')
  const folderAccessSupported = typeof window.showDirectoryPicker === 'function'
  let selected
  let selecting = false
  const mailbox = new FolderMailbox({
    execute, cancel,
    onState(value) {
      if (value.state === 'connected') {
        button.textContent = 'agent connected'
        button.dataset.connected = 'true'
        drop.hidden = true
        allow.hidden = true
        connected.hidden = false
        status.textContent = `${value.folder} · ${value.count} commands`
        prompt.textContent = `Use the shared folder ${JSON.stringify(value.folder)} in your workspace to control my browser's Strands Shell. Read AGENT.md and session.json in that folder, then follow the file protocol. Start by inspecting the workspace through the browser shell. Ask me for the folder's full path if you cannot locate it.`
      } else if (value.state === 'closed') {
        button.textContent = 'connect agent'
        button.dataset.connected = 'false'
        status.textContent = 'Disconnected. The folder can be reused.'
        drop.hidden = false
        connected.hidden = true
        selected = null
      } else {
        status.textContent = value.message
      }
    },
  })
  async function select(handle) {
    if (!handle || handle.kind !== 'directory') throw new Error('Drop a folder, not a file.')
    selected = handle
    status.textContent = `${handle.name} selected. Allow this page to exchange commands through it.`
    allow.hidden = false
    allow.textContent = `Connect ${handle.name}`
  }
  function showError(error) {
    if (error.name !== 'AbortError') status.textContent = error.message
  }
  button.addEventListener('click', () => dialog.showModal())
  choose.addEventListener('click', async () => {
    if (selecting) return
    selecting = true
    try {
      await select(await showDirectoryPicker({ id: 'strands-agent', mode: 'readwrite' }))
    } catch (error) { showError(error) }
    finally { selecting = false }
  })
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.dataset.dragging = 'true' })
  drop.addEventListener('dragleave', () => { drop.dataset.dragging = 'false' })
  drop.addEventListener('drop', async event => {
    event.preventDefault()
    event.stopPropagation()
    drop.dataset.dragging = 'false'
    // Obtain the promise synchronously while the drag data is still available.
    const item = [...event.dataTransfer.items].find(item => item.kind === 'file')
    try {
      await select(await item?.getAsFileSystemHandle?.())
    } catch (error) {
      status.textContent = error.message || 'Could not read the dropped folder. Try “choose a folder” instead.'
    }
  })
  allow.addEventListener('click', async () => {
    if (!selected || selecting) return
    selecting = true
    allow.disabled = true
    try {
      if (await selected.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('Folder permission was declined. Nothing is connected.')
      }
      await mailbox.connect(selected)
    } catch (error) { showError(error) }
    finally { selecting = false; allow.disabled = false }
  })
  document.querySelector('#agent-copy').addEventListener('click', async event => {
    try {
      await navigator.clipboard.writeText(prompt.textContent)
      event.target.textContent = 'copied'
    } catch { status.textContent = 'Select and copy the instructions below.' }
  })
  document.querySelector('#agent-disconnect').addEventListener('click', () => void mailbox.disconnect())
  document.querySelector('#agent-close').addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', focus)
  window.addEventListener('pagehide', () => void mailbox.disconnect(false))
  if (!folderAccessSupported) {
    drop.hidden = true
    choose.disabled = true
    status.setAttribute('role', 'alert')
    status.textContent = 'This browser cannot connect to a local folder. Open this page in desktop Chrome or Edge to use an agent.'
  }
  return mailbox
}
