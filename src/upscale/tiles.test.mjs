/**
 * 分塊的純邏輯測試（移植自 rust-ai-webtool 的 `upscale/tests.rs`）。
 *
 * 分塊的正確性是這個功能最容易默默壞掉的地方：算錯 halo 或偏移不會讓程式報錯，
 * 只會在拼接處留下接縫。這裡把「core 完整覆蓋、不重疊」「ext 含住 core 且不越界」
 * 「偏移可還原」三件事釘住。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { HALO, MAX_OUT_PIXELS, sizeProblem, tileSpans } from './tiles.js'

const coreLen = (s) => s.coreEnd - s.coreStart
const offset = (s) => s.coreStart - s.extStart

test('core 恰好把 [0,len) 切成不重不漏的連續區段', () => {
  for (const len of [1, 7, 63, 64, 65, 255, 256, 257, 1000]) {
    for (const tile of [32, 64, 256]) {
      const spans = tileSpans(len, tile, HALO)
      assert.equal(spans[0].coreStart, 0, `len=${len} tile=${tile}`)
      assert.equal(spans.at(-1).coreEnd, len, `len=${len} tile=${tile}`)
      for (let i = 1; i < spans.length; i++) {
        assert.equal(spans[i - 1].coreEnd, spans[i].coreStart, `len=${len} tile=${tile} 有斷層或重疊`)
      }
      assert.equal(spans.reduce((n, s) => n + coreLen(s), 0), len)
      assert.ok(spans.every((s) => coreLen(s) <= tile), `len=${len} tile=${tile} core 超過 tile`)
    }
  }
})

test('ext 含住自己的 core、不超出影像範圍，且在非邊界處真的擴滿 halo', () => {
  const len = 700
  for (const s of tileSpans(len, 256, HALO)) {
    assert.ok(s.extStart <= s.coreStart && s.extEnd >= s.coreEnd)
    assert.ok(s.extEnd <= len, '超出右界')
    if (s.coreStart >= HALO) assert.equal(offset(s), HALO, '左側 halo 不足')
    else assert.equal(s.extStart, 0, '左側應夾到 0')
    if (s.coreEnd + HALO <= len) assert.equal(s.extEnd, s.coreEnd + HALO, '右側 halo 不足')
    else assert.equal(s.extEnd, len, '右側應夾到 len')
  }
})

test('影像比 tile 小時只會有一塊，且完全沒有 halo 可擴', () => {
  assert.deepEqual(tileSpans(100, 256, HALO), [{ coreStart: 0, coreEnd: 100, extStart: 0, extEnd: 100 }])
})

test('偏移可以還原 core 在 ext 裡的位置（裁切的關鍵）', () => {
  for (const s of tileSpans(1000, 128, HALO)) {
    assert.ok(offset(s) + coreLen(s) <= s.extEnd - s.extStart, '裁切會越界')
    assert.equal(s.extStart + offset(s), s.coreStart)
  }
})

test('尺寸檢查：放大後超過上限要擋下，並建議改用較小的倍率', () => {
  assert.equal(sizeProblem(1000, 1000, 4), '')
  assert.match(sizeProblem(3000, 3000, 4), /2×/)
  assert.ok(3000 * 3000 * 4 * 4 > MAX_OUT_PIXELS)
  assert.equal(sizeProblem(0, 10, 2), '圖片尺寸為 0')
})
