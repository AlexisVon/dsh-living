/** Replace lone UTF-16 surrogates; the gateway rejects them. */
export function sanitizeText(text) {
  let out = ''
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0)
    out += code >= 0xd800 && code <= 0xdfff ? '�' : char
  }
  return out
}

/** Split by code points so one WeChat message never exceeds the gateway limit. */
export function splitText(text, maxLen = 4000) {
  const chars = Array.from(sanitizeText(text))
  const limit = Math.max(1, Math.floor(Number(maxLen) || 4000))
  if (chars.length <= limit) return [chars.join('')]
  const total = Math.ceil(chars.length / limit)
  const prefixWidth = `（${total}/${total}）`.length
  const take = Math.max(1, limit - prefixWidth)
  const chunks = []
  for (let index = 0; index < chars.length; index += take) chunks.push(chars.slice(index, index + take).join(''))
  return chunks.map((chunk, index) => `（${index + 1}/${chunks.length}）${chunk}`)
}
