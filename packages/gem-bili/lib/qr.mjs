import qrcodeFactory from './vendor/qrcode.mjs'

const BLACK = '\x1b[40m  \x1b[0m'
const WHITE = '\x1b[47m  \x1b[0m'

export function qrSvgFor(text, { cellSize = 2, margin = 2 } = {}) {
  const qr = qrcodeFactory(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize, margin, scalable: true })
}

/** Render as ANSI background blocks: dark-on-light stays scannable on dark terminals. */
export function renderTerminalQr(text, { margin = 2 } = {}) {
  const qr = qrcodeFactory(0, 'M')
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  const lines = []
  for (let row = -margin; row < size + margin; row += 1) {
    let line = ''
    for (let col = -margin; col < size + margin; col += 1) {
      const dark = row >= 0 && col >= 0 && row < size && col < size && qr.isDark(row, col)
      line += dark ? BLACK : WHITE
    }
    lines.push(line)
  }
  return lines.join('\n')
}
