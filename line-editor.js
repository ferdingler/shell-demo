import { colors, plainText } from './terminal-text.js'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const segments = text => Array.from(segmenter.segment(text), part => part.segment)
const maxInput = 64 * 1024

// xterm owns rendering, selection, input methods, and scrolling. This is the
// local line discipline; the browser engine accepts complete commands, not keys.
export class LineEditor {
  constructor(term, { submit, interrupt, complete }) {
    this.term = term
    this.submit = submit
    this.interrupt = interrupt
    this.complete = complete
    this.history = []
    this.historyIndex = 0
    this.draft = ''
    this.text = []
    this.cursor = 0
    this.active = false
    this.queue = Promise.resolve()
    term.onData(data => this.enqueue(() => this.input(data)))
    term.attachCustomKeyEventHandler(event => {
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'c' && term.hasSelection()) return false
      if ((event.ctrlKey || event.metaKey) && key === 'v') return false
      if (event.key === 'Tab' && event.shiftKey) return false
      if (event.key === 'Enter' && event.shiftKey) {
        if (event.type === 'keydown') {
          event.preventDefault()
          this.enqueue(() => this.insert('\n'))
        }
        return false
      }
      return true
    })
  }

  enqueue(action) {
    this.queue = this.queue.then(action).catch(error => {
      console.error(error)
    })
    return this.queue
  }

  write(text) {
    return new Promise(resolve => this.term.write(text, resolve))
  }

  async prompt(path) {
    this.path = path
    this.text = []
    this.cursor = 0
    this.historyIndex = this.history.length
    this.draft = ''
    this.active = true
    this.anchor?.dispose()
    this.anchor = this.term.registerMarker(0)
    await this.render()
  }

  async render() {
    if (!this.active) return
    this.term.scrollToBottom()
    const row = Math.max(0, this.anchor.line - this.term.buffer.active.baseY)
    const format = text => text.replaceAll('\n', `\r\n${colors.muted}· ${colors.reset}`)
    await this.write(`\x1b[${row + 1};1H\x1b[J${colors.green}${this.path}${colors.muted} ❯ ${colors.reset}${format(this.text.slice(0, this.cursor).join(''))}`)
    if (this.term.buffer.active.cursorX === this.term.cols) await this.write('\r\n')
    const cursorMarker = this.term.registerMarker(0)
    const column = this.term.buffer.active.cursorX
    await this.write(format(this.text.slice(this.cursor).join('')))
    const cursorRow = Math.max(0, cursorMarker.line - this.term.buffer.active.baseY)
    await this.write(`\x1b[${cursorRow + 1};${Math.min(column, this.term.cols - 1) + 1}H`)
    cursorMarker.dispose()
  }

  async insert(value) {
    if (!this.active) return
    const cleaned = plainText(value.replaceAll('\r\n', '\n').replaceAll('\r', '\n'))
    const remaining = maxInput - this.text.join('').length
    const addition = segments(cleaned.slice(0, remaining))
    this.text.splice(this.cursor, 0, ...addition)
    this.cursor += addition.length
    await this.render()
  }

  async replace(value) {
    this.text = segments(value)
    this.cursor = this.text.length
    await this.render()
  }

  async clear() {
    await this.write('\x1b[2J\x1b[3J\x1b[H')
    this.anchor?.dispose()
    this.anchor = this.term.registerMarker(0)
    await this.render()
  }

  async accept() {
    const command = this.text.join('')
    this.cursor = this.text.length
    await this.render()
    await this.write('\r\n')
    this.active = false
    if (command.trim() && this.history.at(-1) !== command) {
      this.history.push(command)
      if (this.history.length > 500) this.history.shift()
    }
    await this.submit(command)
  }

  async input(data) {
    if (data === '\x03') {
      if (this.active) {
        this.cursor = this.text.length
        await this.render()
        await this.write('^C\r\n')
        await this.prompt(this.path)
      } else {
        this.interrupt()
      }
      return
    }
    if (data === '\x0c') return this.clear()
    if (!this.active) return
    if (data === '\r') return this.accept()
    if (data === '\x7f' || data === '\x08') {
      if (this.cursor > 0) this.text.splice(--this.cursor, 1)
    } else if (data === '\x1b[3~' || data === '\x04') {
      this.text.splice(this.cursor, 1)
    } else if (data === '\x1b[D' || data === '\x02') {
      this.cursor = Math.max(0, this.cursor - 1)
    } else if (data === '\x1b[C' || data === '\x06') {
      this.cursor = Math.min(this.text.length, this.cursor + 1)
    } else if (['\x01', '\x1b[H', '\x1b[1~', '\x1bOH'].includes(data)) {
      this.cursor = 0
    } else if (['\x05', '\x1b[F', '\x1b[4~', '\x1bOF'].includes(data)) {
      this.cursor = this.text.length
    } else if (data === '\x15') {
      this.text.splice(0, this.cursor)
      this.cursor = 0
    } else if (data === '\x0b') {
      this.text.splice(this.cursor)
    } else if (data === '\x17') {
      let start = this.cursor
      while (start > 0 && /\s/.test(this.text[start - 1])) start--
      while (start > 0 && !/\s/.test(this.text[start - 1])) start--
      this.text.splice(start, this.cursor - start)
      this.cursor = start
    } else if (data === '\x1b[A' || data === '\x1b[B' || data === '\x10' || data === '\x0e') {
      if (this.historyIndex === this.history.length) this.draft = this.text.join('')
      const up = data === '\x1b[A' || data === '\x10'
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (up ? -1 : 1)))
      return this.replace(this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex])
    } else if (data === '\t') {
      const before = this.text.slice(0, this.cursor).join('')
      const choices = this.complete(before)
      if (choices.length === 1) return this.insert(choices[0])
      if (choices.length > 1) {
        this.cursor = this.text.length
        await this.render()
        await this.write(`\r\n${colors.muted}${choices.join('  ')}${colors.reset}\r\n`)
        this.anchor?.dispose()
        this.anchor = this.term.registerMarker(0)
      }
    } else if (data.startsWith('\x1b')) {
      return
    } else {
      return this.insert(data)
    }
    await this.render()
  }
}
