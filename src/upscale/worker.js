// 在 Web Worker 裡跑 SPAN 放大（onnxruntime-web）。
//
// 放在 Worker 是因為 CPU 後端一塊要算好幾秒，放在主執行緒整個頁面會卡死；WebGPU 在
// Worker 裡一樣可用。主執行緒只負責解碼原圖、把 RGBA 交過來，再把結果編碼成檔案。
//
// 訊息：
//   → {id, model, backend, width, height, pixels}   pixels 是 RGBA Uint8ClampedArray
//   ← {id, progress: [完成塊數, 總塊數]}
//   ← {id, width, height, pixels} | {id, error}
import * as ort from 'onnxruntime-web'
import { HALO, TILE, tileSpans } from './tiles.js'

const base = new URL(import.meta.env.BASE_URL, self.location.origin).href
// ORT 的 .wasm 由 Vite 當成資源一起輸出（見 vite.config.js），不必設 wasmPaths。
// 多執行緒需要 cross-origin isolation，GitHub Pages 給不了；硬開只會多一行警告。
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1

const sessions = new Map()
function session(model, backend) {
  const key = `${model}:${backend}`
  if (!sessions.has(key)) {
    const p = ort.InferenceSession.create(`${base}models/${model}.onnx`, {
      executionProviders: [backend],
      graphOptimizationLevel: 'all',
    })
    p.catch(() => sessions.delete(key)) // 失敗的不要快取，下次重試
    sessions.set(key, p)
  }
  return sessions.get(key)
}

async function upscale({ id, model, backend, width: w, height: h, pixels }) {
  const sess = await session(model, backend)
  const xs = tileSpans(w, TILE, HALO)
  const ys = tileSpans(h, TILE, HALO)
  const total = xs.length * ys.length
  let scale = 0
  let out = null
  let ow = 0
  let done = 0
  self.postMessage({ id, progress: [0, total] })

  for (const ty of ys) {
    for (const tx of xs) {
      const ew = tx.extEnd - tx.extStart
      const eh = ty.extEnd - ty.extStart
      const n = ew * eh
      // RGBA → CHW、[0,1]。
      const data = new Float32Array(3 * n)
      for (let y = 0; y < eh; y++) {
        let p = ((ty.extStart + y) * w + tx.extStart) * 4
        for (let x = 0; x < ew; x++, p += 4) {
          const i = y * ew + x
          data[i] = pixels[p] / 255
          data[n + i] = pixels[p + 1] / 255
          data[2 * n + i] = pixels[p + 2] / 255
        }
      }
      const input = new ort.Tensor('float32', data, [1, 3, eh, ew])
      const { output } = await sess.run({ input })
      input.dispose()

      // 倍率從輸出形狀讀，不另外傳：權重本身就決定了它。
      const s = output.dims[3] / ew
      if (!out) {
        scale = s
        ow = w * s
        out = new Uint8ClampedArray(ow * h * s * 4)
      }
      const o = output.data
      const on = eh * s * ew * s
      const rowLen = ew * s
      // 裁掉 halo：core 在 ext 內的偏移放大 s 倍。Uint8ClampedArray 寫入時本身就會
      // 夾到 0~255 並四捨五入，所以直接乘 255 就是量化。
      const cw = (tx.coreEnd - tx.coreStart) * s
      const ch = (ty.coreEnd - ty.coreStart) * s
      const ox = (tx.coreStart - tx.extStart) * s
      const oy = (ty.coreStart - ty.extStart) * s
      for (let y = 0; y < ch; y++) {
        let src = (oy + y) * rowLen + ox
        let dst = ((ty.coreStart * s + y) * ow + tx.coreStart * s) * 4
        for (let x = 0; x < cw; x++, src++, dst += 4) {
          out[dst] = o[src] * 255
          out[dst + 1] = o[on + src] * 255
          out[dst + 2] = o[2 * on + src] * 255
          out[dst + 3] = 255
        }
      }
      output.dispose()
      self.postMessage({ id, progress: [++done, total] })
    }
  }
  self.postMessage({ id, width: ow, height: h * scale, pixels: out }, [out.buffer])
}

self.onmessage = async (e) => {
  try {
    await upscale(e.data)
  } catch (err) {
    self.postMessage({ id: e.data.id, error: String(err?.message || err) })
  }
}
