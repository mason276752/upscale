// 主執行緒這一側：管理放大用的 Worker（見 worker.js），一次一張依序送進去。

let worker = null
const jobs = new Map()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const { id, progress, error, ...result } = e.data
    const job = jobs.get(id)
    if (!job) return
    if (progress) {
      job.onProgress?.(progress[0], progress[1])
      return
    }
    jobs.delete(id)
    if (error) job.reject(new Error(error))
    else job.resolve(result)
  }
  worker.onerror = (e) => {
    fail(new Error(`放大失敗：${e.message || '無法啟動運算'}`))
  }
  return worker
}

function fail(err) {
  worker?.terminate()
  worker = null
  for (const job of jobs.values()) job.reject(err)
  jobs.clear()
}

/**
 * 放大一張圖。`pixels`（RGBA）會被轉移給 Worker，呼叫後不能再用。
 *
 * @returns {Promise<{width: number, height: number, pixels: Uint8ClampedArray}>}
 */
export function upscalePixels({ model, backend, width, height, pixels }, onProgress) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    jobs.set(id, { resolve, reject, onProgress })
    getWorker().postMessage({ id, model, backend, width, height, pixels }, [pixels.buffer])
  })
}

/** 中斷進行中的放大（直接收掉 Worker；下次放大會重新載入模型，模型很小所以無感）。 */
export function cancelAll() {
  fail(new Error('已取消'))
}

/** 有 WebGPU 就用 GPU，否則退回 CPU（WASM）。 */
export async function detectBackend() {
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return 'webgpu'
  } catch {
    // 某些瀏覽器有 navigator.gpu 但 requestAdapter 會丟例外（例如被政策關掉）
  }
  return 'wasm'
}
