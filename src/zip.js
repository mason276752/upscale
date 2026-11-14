// 只存不壓的 ZIP（與 paste2jpg 同一份寫法）。結果只是要交給 ZIP 編輯器合併，
// 它下載時會再依使用者選的壓縮程度重新打包，這裡壓縮只是白花時間。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * @param {{name: string, blob: Blob}[]} list 檔名需互不相同
 * @returns {Promise<Blob>}
 */
export async function makeZip(list) {
  const enc = new TextEncoder()
  const d = new Date()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const parts = []
  const central = []
  let offset = 0
  for (const { name: fileName, blob } of list) {
    const name = enc.encode(fileName)
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()))
    // 本地標頭與中央目錄共用這些欄位，只是位移不同。
    const common = (dv, at) => {
      dv.setUint16(at, 20, true) // version needed: 2.0
      dv.setUint16(at + 2, 0x0800, true) // 檔名是 UTF-8
      dv.setUint16(at + 4, 0, true) // stored
      dv.setUint16(at + 6, time, true)
      dv.setUint16(at + 8, date, true)
      dv.setUint32(at + 10, crc, true)
      dv.setUint32(at + 14, blob.size, true)
      dv.setUint32(at + 18, blob.size, true)
      dv.setUint16(at + 22, name.length, true)
    }
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    common(local, 4)
    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true) // version made by
    common(entry, 6)
    entry.setUint32(42, offset, true)
    parts.push(local, name, blob)
    central.push(entry, name)
    offset += 30 + name.length + blob.size
  }
  const dirSize = central.reduce((s, p) => s + p.byteLength, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, list.length, true)
  end.setUint16(10, list.length, true)
  end.setUint32(12, dirSize, true)
  end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end], { type: 'application/zip' })
}
