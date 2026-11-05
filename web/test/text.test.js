import assert from 'node:assert/strict'
import test from 'node:test'
import { displayPath, plainText, terminalText } from '../terminal-text.js'

test('output preserves ordinary text, Unicode, and colors', () => {
  const output = 'hello 世界\n\t\x1b[31mred\x1b[0m\n'
  assert.equal(terminalText(output), output)
  assert.equal(plainText(output), 'hello 世界\n\tred\n')
})

test('output cannot clear the screen, set titles, link, or write the clipboard', () => {
  assert.equal(terminalText('\x1b[2Jhello\x1b[H'), 'hello')
  assert.equal(terminalText('\x1b]0;fake title\x07hello'), 'hello')
  assert.equal(terminalText('\x1b]52;c;aGVsbG8=\x1b\\hello'), 'hello')
  assert.equal(terminalText('\x1b]8;;https://example.com\x07click\x1b]8;;\x07'), 'click')
  assert.equal(terminalText('\x1bPmalicious\x1b\\hello'), 'hello')
  assert.equal(terminalText('hello\x1b]52;unfinished'), 'hello')
  assert.equal(terminalText('\x07hello\x9b'), 'hello')
})

test('prompt safely abbreviates only the actual home directory', () => {
  assert.equal(displayPath('/home/lash/workspace'), '~/workspace')
  assert.equal(displayPath('/home/lash'), '~')
  assert.equal(displayPath('/home/lash-other'), '/home/lash-other')
  assert.equal(displayPath('/tmp/\x1b[31mfoo\nbar'), '/tmp/foobar')
})
