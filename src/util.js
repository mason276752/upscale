const pad = (n) => String(n).padStart(2, '0')

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

export function timeStamp() {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** `name` 若已在 `taken` 裡，就在副檔名前加上「 2」「 3」…；回傳的名字會加進 `taken`。 */
export function uniqueName(name, taken) {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  let out = name
  for (let n = 2; taken.has(out); n++) out = `${stem} ${n}${ext}`
  taken.add(out)
  return out
}
