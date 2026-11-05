// Keep SGR (text color/style), but never let command output move the cursor,
// change the window title, set a clipboard, or forge a hyperlink.
export function terminalText(value) {
  return value.replace(
    /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[P_X^][\s\S]*?(?:\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    sequence => /^\x1b\[[0-9;:]*m$/.test(sequence) ? sequence : '',
  )
}

export function plainText(value) {
  return terminalText(value).replace(/\x1b\[[0-9;:]*m/g, '')
}

export const colors = {
  reset: '\x1b[0m',
  muted: '\x1b[38;2;142;153;146m',
  green: '\x1b[38;2;181;219;149m',
  red: '\x1b[38;2;237;150;140m',
  white: '\x1b[38;2;220;225;217m',
  blue: '\x1b[38;2;146;185;204m',
}

export function wrapText(text, columns) {
  const lines = []
  for (const word of text.split(' ')) {
    const line = lines.at(-1)
    if (!line || line.length + word.length + 1 > columns) lines.push(word)
    else lines[lines.length - 1] += ` ${word}`
  }
  return lines.join('\r\n')
}

export function displayPath(cwd) {
  const path = plainText(cwd).replace(/[\r\n\t]/g, '')
  return path === '/home/lash' || path.startsWith('/home/lash/')
    ? `~${path.slice('/home/lash'.length)}`
    : path
}
