// 分塊（tiling）與尺寸上限。移植自 rust-ai-webtool 的 `ai-image::upscale::model`。
//
// SPAN 是全卷積網路，感受野只有 HALO 像素：每塊多算 halo 再裁掉，拼出來的結果就與整張
// 一次跑完全一致——不需要淡入淡出混色，也不會有接縫。

/**
 * 網路的感受野半徑：conv_1(1) ＋ 6 個 SPAB×3 個 3×3(18) ＋ conv_2(1) ＋ upsampler(1)
 * ＝ 21 像素（conv_cat 是 1×1，不增加）。
 */
export const HALO = 21

/** 分塊邊長。298²（=256+2×21）的 48 通道 f32 中繼張量約 17MB，一般 GPU 都吃得下。 */
export const TILE = 256

/**
 * 輸出像素上限（約 7000×7000）。結果要整張放在記憶體裡、再畫進 canvas 編碼，RGBA 就要
 * 200MB；再大就不是「慢」而是分頁直接崩潰。手機的 canvas 上限更低，失敗時另有訊息。
 */
export const MAX_OUT_PIXELS = 50_000_000

/**
 * 把長度 `len` 切成每塊至多 `tile` 的 core，並各自向外擴 `halo`（在邊界處自動夾住）。
 * `core` 是最終要保留的區間，`ext` 是實際餵給網路的（含 halo）區間，都是 `[start, end)`。
 *
 * @returns {{coreStart:number, coreEnd:number, extStart:number, extEnd:number}[]}
 */
export function tileSpans(len, tile, halo) {
  if (!(tile > 0)) throw new Error('tile 必須為正')
  const out = []
  for (let s = 0; s < len; ) {
    const coreEnd = Math.min(s + tile, len)
    out.push({ coreStart: s, coreEnd, extStart: Math.max(0, s - halo), extEnd: Math.min(coreEnd + halo, len) })
    s = coreEnd
  }
  // len == 0 不該發生（呼叫端已擋掉零尺寸圖），但別回傳空清單讓上層迴圈默默跳過。
  if (!out.length) out.push({ coreStart: 0, coreEnd: 0, extStart: 0, extEnd: 0 })
  return out
}

/** 尺寸檢查；可以放大回空字串，否則回給人看的原因。 */
export function sizeProblem(w, h, scale) {
  if (!w || !h) return '圖片尺寸為 0'
  const out = w * h * scale * scale
  if (out > MAX_OUT_PIXELS) {
    return `放大後是 ${w * scale}×${h * scale}（${(out / 1e6).toFixed(1)}MP），超過 ${MAX_OUT_PIXELS / 1e6}MP 上限——請改用 2× 或先縮小原圖`
  }
  return ''
}
