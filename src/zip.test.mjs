import { test } from 'vitest'
import assert from 'node:assert/strict'
import { crc32, makeZip } from './zip.js'

test('CRC-32 對得上標準檢查值', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  assert.equal(crc32(new Uint8Array(0)), 0)
})

test('ZIP 的本地標頭、中央目錄與結尾紀錄都在對的位置', async () => {
  const data = new TextEncoder().encode('hello')
  const zip = new DataView(await (await makeZip([{ name: '中文.txt', blob: new Blob([data]) }])).arrayBuffer())
  const nameLen = new TextEncoder().encode('中文.txt').length
  assert.equal(zip.getUint32(0, true), 0x04034b50, '本地標頭簽章')
  assert.equal(zip.getUint16(6, true), 0x0800, '檔名標成 UTF-8，ZIP 編輯器才不會猜成 GBK')
  assert.equal(zip.getUint32(14, true), crc32(data))
  assert.equal(zip.getUint32(18, true), 5, '壓縮後大小')
  const centralAt = 30 + nameLen + 5
  assert.equal(zip.getUint32(centralAt, true), 0x02014b50, '中央目錄簽章')
  const endAt = zip.byteLength - 22
  assert.equal(zip.getUint32(endAt, true), 0x06054b50, '結尾紀錄簽章')
  assert.equal(zip.getUint16(endAt + 10, true), 1, '檔案數')
  assert.equal(zip.getUint32(endAt + 16, true), centralAt, '中央目錄的位移')
})
