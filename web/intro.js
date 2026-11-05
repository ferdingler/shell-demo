import { colors, wrapText } from './terminal-text.js'

const strands = [
  "     _                       _",
  " ___| |_ _ __ __ _ _ __   __| |___",
  "/ __| __| '__/ _` | '_ \\ / _` / __|",
  "\\__ \\ |_| | | (_| | | | | (_| \\__ \\",
  "|___/\\__|_|  \\__,_|_| |_|\\__,_|___/",
]
const shell = [
  "     _          _ _",
  " ___| |__   ___| | |",
  "/ __| '_ \\ / _ \\ | |",
  "\\__ \\ | | |  __/ | |",
  "|___/_| |_|\\___|_|_|",
]
const width = Math.max(...strands.map(line => line.length))
const wide = strands.map((line, index) => `${line.padEnd(width + 3)}${shell[index]}`.trimEnd())
const wideWidth = Math.max(...wide.map(line => line.length))
const description = 'A sandboxed, Bourne-compatible shell for AI agents. Written in Rust with an in-memory filesystem.'
const suggestion = 'Try commands like ls, mkdir, cat, cd, jq and many others.'

export function intro(columns) {
  const artwork = columns >= wideWidth ? wide
    : columns >= width ? [...strands, '', ...shell]
      : ['strands / shell']
  return `${colors.green}${artwork.join('\r\n')}${colors.reset}\r\n\r\n` +
    `${colors.muted}${wrapText(description, columns)}\r\n${wrapText(suggestion, columns)}${colors.reset}\r\n\r\n`
}
