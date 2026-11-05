// Tab completion for the line editor. Command names cover the shell's commands
// plus the page's own (clear, help, history, reset); other words complete
// against the names in the current directory, with directories ending in '/'.
export const commands = 'alias basename cat cd chmod clear cp cut date dirname echo env exit export false find grep head help history jq ln ls lua mkdir mktemp mv printf pwd read readlink reset rm rmdir sed sleep sort source tail tee test touch tr true type uniq unset wc xargs'.split(' ')

// Returns either a single insertion for the text before the cursor, or the
// list of candidates when several match.
export function complete(before, files) {
  const match = before.match(/(?:^|[\s;|])([\w./-]*)$/)
  if (!match) return []
  const word = match[1]
  const isCommand = /(?:^|[;|])\s*[\w.-]*$/.test(before)
  const choices = (isCommand ? commands : files)
    .filter(name => name.startsWith(word) && /^[\w./-]+$/.test(name))
    .sort()
  return choices.length === 1
    ? [choices[0].slice(word.length) + (choices[0].endsWith('/') ? '' : ' ')]
    : choices
}
