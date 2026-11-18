import { createHash } from 'node:crypto'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

export function mixinKey(imgKey, subKey) {
  const source = `${imgKey}${subKey}`
  return MIXIN_KEY_ENC_TAB.map((index) => source[index] ?? '').join('').slice(0, 32)
}

/** WBI signature: filter `!'()*`, sort, urlencode, then md5(query + mixin key). */
export function encWbi(params, { imgKey, subKey }, nowSeconds = Math.floor(Date.now() / 1000)) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    search.set(key, String(value).replace(/[!'()*]/g, ''))
  }
  search.set('wts', String(nowSeconds))
  search.sort()
  const query = search.toString()
  const wRid = createHash('md5').update(query + mixinKey(imgKey, subKey)).digest('hex')
  return { ...Object.fromEntries(search), w_rid: wRid }
}

export function keysFromUrls(imgUrl, subUrl) {
  const key = (url) => String(url ?? '').split('/').pop().split('.')[0]
  return { imgKey: key(imgUrl), subKey: key(subUrl) }
}
