<script setup>
// 圖片放大：SPAN（4×／2×）在瀏覽器裡跑，有 WebGPU 用 GPU、沒有就退回 CPU。
//   * 模型：rust-ai-webtool 用的同一組權重（Phips 的 NomosUni SPAN，CC-BY-4.0），
//     用 tools/export-onnx.py 轉成 ONNX、與 PyTorch 逐像素比對過
//   * 推論：onnxruntime-web，在 Web Worker 裡分塊跑（見 upscale/）
//   * 串接：別的工具傳來的圖，放大好、之後每次改變都自動傳回來源；也能直接傳到去背（見 bridge.js）
//   * HEIC／HEIF：瀏覽器解不開的先轉成 PNG（見 heif.js）
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './components/Icon.vue'
import CompareView from './components/CompareView.vue'
import { bridgeSupported, listen, sendFiles, sendResult, sendToEditor, toolLabel } from './bridge.js'
import { makeZip } from './zip.js'
import { fmtBytes, saveBlob, timeStamp, uniqueName } from './util.js'
import { EXT, applyScaledAlpha, decodeImage, encodePixels, reencode } from './image.js'
import { ensureDecodable } from './heif.js'
import { sizeProblem } from './upscale/tiles.js'
import { cancelAll, detectBackend, upscalePixels } from './upscale/index.js'

// ---------- toast ----------
const toastMsg = ref('')
let toastTimer
function toast(msg) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 3600)
}

// ---------- 設定 ----------
const MODELS = {
  4: { id: 'span-4x', label: '4×', note: '通用照片／插畫，耐得住 JPEG 雜訊' },
  2: { id: 'span-2x', label: '2×', note: '只放大兩倍，輸出檔小很多' },
}
const FORMATS = [
  { type: 'image/png', label: 'PNG（無損）' },
  { type: 'image/jpeg', label: 'JPG' },
  { type: 'image/webp', label: 'WebP' },
]
const scale = ref(4)
const format = ref('image/png')
const backend = ref('') // 'webgpu' | 'wasm'
const backendLabel = computed(() =>
  backend.value === 'webgpu' ? 'WebGPU 加速' : backend.value === 'wasm' ? 'CPU 運算（較慢）' : '偵測中…',
)

// ---------- 圖片 ----------
// File、Blob 一律 markRaw：交給 Vue 代理的話，原生方法會因為 `this` 是 Proxy 而出錯。
// { id, file, name, srcUrl, width, height, status, progress, error, result }
// status: 'queued' | 'running' | 'done' | 'error'
// result: { blob, url, width, height, scale }
const items = ref([])
const selectedId = ref(null)
const selected = computed(() => items.value.find((i) => i.id === selectedId.value) || null)
const doneItems = computed(() => items.value.filter((i) => i.status === 'done'))
const fileInput = ref(null)

const isImage = (f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg|ico|heic|heif|hif)$/i.test(f.name)

// origins[i]：files[i] 從哪個工具來（見 bridge.js），放大的結果會自動傳回去。
function addFiles(list, from, origins = []) {
  const files = [...list]
  const picked = files.map((f, i) => [f, origins[i] ?? null]).filter(([f]) => isImage(f))
  const images = picked.map(([f]) => f)
  if (!images.length) {
    if (files.length) toast('沒有可以處理的圖片')
    return
  }
  const added = picked.map(([f, origin]) => ({
    id: crypto.randomUUID(),
    file: markRaw(f),
    origin: origin && markRaw(origin), // 不要變成 Proxy：轉傳給別的工具時要能 postMessage
    returned: '', // '' | 'ok' | 'failed'
    name: f.name || 'image.png',
    srcUrl: URL.createObjectURL(f),
    width: 0,
    height: 0,
    status: 'queued',
    progress: 0,
    error: '',
    result: null,
    run: 0,
  }))
  items.value.push(...added)
  if (!selected.value) selectedId.value = added[0].id
  const skipped = files.length - images.length
  const who = from ? `從${toolLabel(from)}收到` : '已加入'
  const back = picked.find(([, o]) => o)?.[1]
  toast(`${who} ${images.length} 張圖片${skipped ? `（略過 ${skipped} 個不是圖片的）` : ''}${back ? `，放大好會自動傳回${toolLabel(back.app)}` : ''}`)
  for (const item of items.value.slice(-added.length)) prepare(item)
  pump()
}

// 瀏覽器解不開的 HEIF 一加入就依序轉成 PNG，不等放大的佇列：縮圖早點出來，
// 之後的解碼、前後對照都用轉好的檔。
const prepared = new Map() // id → Promise
let preparing = Promise.resolve()
function prepare(item) {
  let p = prepared.get(item.id)
  if (!p) {
    p = preparing.then(async () => {
      if (!items.value.includes(item)) return
      const file = await ensureDecodable(item.file)
      if (file === item.file || !items.value.includes(item)) return
      URL.revokeObjectURL(item.srcUrl)
      item.file = markRaw(file)
      item.srcUrl = URL.createObjectURL(file)
    })
    preparing = p.catch(() => prepared.delete(item.id)) // 失敗了（例如解碼器沒載到），重試時再轉一次
    prepared.set(item.id, p)
  }
  return p
}

function dropResult(item) {
  if (item.result) URL.revokeObjectURL(item.result.url)
  item.result = null
}

function removeItem(item) {
  if (item.status === 'running') {
    cancelAll() // 會讓 pump 裡那張以「已取消」結束
  }
  dropResult(item)
  URL.revokeObjectURL(item.srcUrl)
  prepared.delete(item.id)
  const i = items.value.indexOf(item)
  items.value.splice(i, 1)
  if (selectedId.value === item.id) selectedId.value = items.value[Math.min(i, items.value.length - 1)]?.id ?? null
}

function clearAll() {
  for (const item of [...items.value]) removeItem(item)
}

// ---------- 依序放大 ----------
let pumping = false
async function pump() {
  if (pumping || !backend.value) return
  pumping = true
  try {
    for (;;) {
      const item = items.value.find((i) => i.status === 'queued')
      if (!item) break
      await process(item)
    }
  } finally {
    pumping = false
  }
}

// 每次開始處理一張就發一個序號。取消（換倍率、移除）的通知要等一個 microtask 才會回來，
// 那時這張可能已經重新排隊了——序號對不上就代表這次的結果作廢，不能再動它的狀態。
let runSeq = 0

async function process(item) {
  const s = scale.value
  const run = ++runSeq
  item.run = run
  item.status = 'running'
  item.progress = 0
  item.error = ''
  item.returned = ''
  try {
    await prepare(item)
    const src = await decodeImage(item.file)
    item.width = src.width
    item.height = src.height
    const problem = sizeProblem(src.width, src.height, s)
    if (problem) throw new Error(problem)
    let out
    try {
      out = await upscalePixels(
        { model: MODELS[s].id, backend: backend.value, width: src.width, height: src.height, pixels: src.pixels },
        (done, total) => { item.progress = total ? done / total : 0 },
      )
    } catch (err) {
      // WebGPU 偶爾會在特定驅動上失敗；退回 CPU 再跑一次（要重新解碼：像素已經轉移出去了）。
      if (backend.value !== 'webgpu' || err.message === '已取消') throw err
      console.warn('webgpu failed, falling back to wasm', err)
      backend.value = 'wasm'
      toast('GPU 加速無法使用，改用 CPU 運算（會比較慢）')
      const again = await decodeImage(item.file)
      out = await upscalePixels(
        { model: MODELS[s].id, backend: 'wasm', width: again.width, height: again.height, pixels: again.pixels },
        (done, total) => { item.progress = total ? done / total : 0 },
      )
    }
    if (src.hasAlpha) applyScaledAlpha(src.image, out.pixels, out.width, out.height)
    src.image.close?.()
    const blob = await encodePixels(out.pixels, out.width, out.height, format.value)
    // 處理途中換了倍率或被移除：這份結果已經不是使用者要的了。
    if (item.run !== run || !items.value.includes(item)) return
    dropResult(item)
    item.result = { blob: markRaw(blob), url: URL.createObjectURL(blob), width: out.width, height: out.height, scale: s }
    item.status = 'done'
    returnResult(item)
  } catch (err) {
    if (item.run !== run || !items.value.includes(item)) return
    item.status = 'error'
    item.error = err.message === '已取消' ? '已取消' : String(err.message || err)
    if (/memory|allocation|Out of/i.test(item.error)) item.error = '記憶體不夠，請改用 2× 或先縮小原圖'
  }
}

// 換倍率：全部重新放大。
watch(scale, () => {
  if (items.value.some((i) => i.status === 'running')) cancelAll()
  for (const item of items.value) {
    if (item.status !== 'error' || item.error === '已取消' || item.error.includes('上限')) {
      dropResult(item)
      item.run = 0
      item.status = 'queued'
      item.progress = 0
      item.error = ''
    }
  }
  // 等被取消的那張從 pump 迴圈退出再重新開始
  queueMicrotask(() => setTimeout(pump))
})

// 換格式：已完成的重新編碼就好，不必重算。
watch(format, async (type) => {
  for (const item of doneItems.value) {
    const old = item.result
    try {
      const blob = await reencode(old.blob, type)
      if (item.result !== old || format.value !== type) continue
      URL.revokeObjectURL(old.url)
      item.result = { ...old, blob: markRaw(blob), url: URL.createObjectURL(blob) }
      returnResult(item)
    } catch (err) {
      toast(`${item.name}：${err.message}`)
    }
  }
})

function retry(item) {
  item.status = 'queued'
  item.error = ''
  pump()
}

// ---------- 輸出 ----------
function outName(item) {
  const stem = item.name.replace(/\.[^.]+$/, '') || 'image'
  return `${stem}-${item.result.scale}x.${EXT[item.result.blob.type] || 'png'}`
}

function zipList() {
  const taken = new Set()
  return doneItems.value.map((i) => ({ name: uniqueName(outName(i), taken), blob: i.result.blob }))
}
const zipName = () => `upscale-${timeStamp()}.zip`

async function downloadAll() {
  saveBlob(await makeZip(zipList()), zipName())
}

const sending = ref(false)
function reportSend(res, name, count) {
  const label = toolLabel(name)
  if (res === 'sent') toast(`已把 ${count} 張圖片傳到${label}`)
  else if (res === 'blocked') toast(`瀏覽器擋下了新分頁，請先開啟${label}再傳送`)
  else toast(`${label}沒有回應，請再試一次`)
}

async function sendAll() {
  if (sending.value || !doneItems.value.length) return
  sending.value = true
  const list = zipList()
  // 同步呼叫：ZIP 編輯器沒開的話要在這次點擊裡開新分頁。
  const res = await sendToEditor(async () => new File([await makeZip(list)], zipName(), { type: 'application/zip' }))
  sending.value = false
  reportSend(res, 'zipeditor', list.length)
}

/** 結果直接交給另一個工具（例如放大後去背），不經過 ZIP 編輯器。圖原本的來源跟著傳過去，那邊的結果也會回到那裡。 */
async function sendTo(name) {
  if (sending.value || !doneItems.value.length) return
  sending.value = true
  const list = zipList()
  const origins = doneItems.value.map((i) => i.origin)
  const res = await sendFiles(name, async () => ({
    files: list.map((f) => new File([f.blob], f.name, { type: f.blob.type })),
    origins,
  }))
  sending.value = false
  reportSend(res, name, list.length)
}

/** 從別的工具來的圖：每次有新結果（放大好、換輸出格式）就傳回來源。 */
async function returnResult(item) {
  if (!item.origin || !item.result) return
  const { blob } = item.result
  const ok = await sendResult(item.origin, item.id, new File([blob], outName(item), { type: blob.type }))
  if (item.result?.blob === blob) item.returned = ok ? 'ok' : 'failed'
}

const returnNote = (i) =>
  !i.origin || !i.returned ? ''
    : i.returned === 'ok' ? ` · 已傳回${toolLabel(i.origin.app)}`
      : ` · ${toolLabel(i.origin.app)}已關閉，沒傳回`

const statusText = (i) =>
  i.status === 'queued' ? '等待中'
    : i.status === 'running' ? `放大中 ${Math.round(i.progress * 100)}%`
      : i.status === 'done' ? `${i.result.width}×${i.result.height} · ${fmtBytes(i.result.blob.size)}${returnNote(i)}`
        : i.error

// ---------- 輸入：選檔、拖放、貼上 ----------
function pick() {
  fileInput.value?.click()
}
function onPick(e) {
  addFiles(e.target.files || [])
  e.target.value = ''
}

function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])]
  if (!files.some(isImage)) return
  e.preventDefault()
  addFiles(files)
}

const dragging = ref(false)
let dragDepth = 0
const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
function onDragEnter(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  dragging.value = true
}
function onDragOver(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(e) {
  if (hasFiles(e) && --dragDepth <= 0) {
    dragDepth = 0
    dragging.value = false
  }
}
function onDrop(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  addFiles(e.dataTransfer.files)
}

let stopListening = () => {}
onMounted(async () => {
  window.addEventListener('paste', onPaste)
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  stopListening = listen((files, from, origins) => addFiles(files, from || 'zipeditor', origins))
  backend.value = await detectBackend()
  pump()
})
onBeforeUnmount(() => {
  window.removeEventListener('paste', onPaste)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  stopListening()
})
</script>

<template>
  <div class="app" :class="{ dragging }">
    <header class="top">
      <div class="brand">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0a7ea4"/><rect x="7" y="15" width="10" height="10" rx="1.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M15 7h10v10M25 7l-8 8" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div>
          <h1>圖片放大</h1>
          <p v-if="!items.length">用 AI 把圖片放大 2 倍或 4 倍、補回細節。檔案不會離開你的裝置。</p>
        </div>
      </div>
      <span class="badge" :class="backend" :title="backend === 'wasm' ? '這個瀏覽器沒有 WebGPU，改用 CPU 計算' : ''">{{ backendLabel }}</span>
    </header>

    <div class="settings panel">
      <div class="field">
        <span class="label">倍率</span>
        <div class="seg">
          <button v-for="(m, s) in MODELS" :key="s" type="button" :class="{ on: scale === Number(s) }"
                  :title="m.note" @click="scale = Number(s)">{{ m.label }}</button>
        </div>
        <span class="note">{{ MODELS[scale].note }}</span>
      </div>
      <div class="field">
        <span class="label">輸出</span>
        <select v-model="format" aria-label="輸出格式">
          <option v-for="f in FORMATS" :key="f.type" :value="f.type">{{ f.label }}</option>
        </select>
      </div>
    </div>

    <template v-if="!items.length">
      <section class="start panel">
        <Icon name="image" class="hero" />
        <strong>把圖片拖進來、貼上，或選擇檔案</strong>
        <span>PNG、JPG、WebP、HEIC、AVIF、GIF……一次可以放很多張，放進來就開始放大</span>
        <div class="start-btns">
          <button type="button" class="btn primary" @click="pick"><Icon name="upload" />選擇圖片</button>
        </div>
      </section>

      <section class="about panel">
        <h2>可以做什麼</h2>
        <ul>
          <li><strong>AI 放大</strong>：用 SPAN 超解析度模型把圖片放大 4 倍或 2 倍，邊緣與紋理比一般縮放清楚，對網路上抓來、壓縮過的 JPG 也耐得住。</li>
          <li><strong>前後對照</strong>：拖曳分隔線比較原圖與結果，可切換 1:1 看細節。</li>
          <li><strong>批次處理</strong>：一次放很多張，依序放大；透明背景的 PNG 會保留透明。iPhone 的 HEIC 照片也能直接放。</li>
          <li><strong>串接其他工具</strong>：在 <a href="../zipeditor/">ZIP 編輯器</a>勾選圖片就能傳過來，放大後再按「傳到 ZIP 編輯器」放回去；也可以按「傳到去背」直接交給<a href="../removebg/">去背</a>。</li>
          <li><strong>不上傳</strong>：模型只有 1.7MB，下載到瀏覽器裡執行。有 WebGPU 的瀏覽器（Chrome、Edge、新版 Safari）用顯示卡加速，其他用 CPU，大圖會比較慢。</li>
        </ul>
      </section>
    </template>

    <template v-else>
      <section class="panel section">
        <h2>
          圖片 <span class="count">{{ items.length }}</span>
          <span class="grow"></span>
          <button type="button" class="btn small" @click="pick"><Icon name="plus" />加入圖片</button>
          <button type="button" class="btn small danger" @click="clearAll"><Icon name="trash" />全部清除</button>
        </h2>
        <ul class="grid">
          <li v-for="item in items" :key="item.id" :class="{ active: item.id === selectedId, [item.status]: true }">
            <button type="button" class="thumb" :title="item.name" @click="selectedId = item.id">
              <img :src="item.result?.url || item.srcUrl" alt="" loading="lazy" />
              <span v-if="item.status === 'running'" class="bar"><span :style="{ width: item.progress * 100 + '%' }"></span></span>
            </button>
            <div class="meta">
              <b :title="item.name">{{ item.name }}</b>
              <span class="status">
                <span v-if="item.status === 'running' || item.status === 'queued'" class="spinner small" aria-hidden="true"></span>
                {{ statusText(item) }}
              </span>
            </div>
            <div class="row-btns">
              <button v-if="item.status === 'done'" type="button" class="btn small icon" title="下載"
                      @click="saveBlob(item.result.blob, outName(item))"><Icon name="download" /></button>
              <button v-if="item.status === 'error'" type="button" class="btn small icon" title="重試" @click="retry(item)"><Icon name="refresh" /></button>
              <button type="button" class="btn small icon danger" title="移除" @click="removeItem(item)"><Icon name="x" /></button>
            </div>
          </li>
        </ul>
        <div class="actions">
          <span class="grow muted">{{ doneItems.length }} / {{ items.length }} 張完成</span>
          <button v-if="doneItems.length > 1" type="button" class="btn" @click="downloadAll"><Icon name="download" />打包下載</button>
          <button v-if="bridgeSupported" type="button" class="btn" :disabled="sending || !doneItems.length"
                  title="放大後的圖直接拿去去背" @click="sendTo('removebg')">
            <Icon name="send" />傳到去背
          </button>
          <button v-if="bridgeSupported" type="button" class="btn primary" :disabled="sending || !doneItems.length" @click="sendAll">
            <Icon name="send" />傳到 ZIP 編輯器
          </button>
        </div>
      </section>

      <section v-if="selected" class="panel section">
        <h2 class="title">{{ selected.name }}</h2>
        <CompareView v-if="selected.status === 'done'" :key="selected.result.url" :before="selected.srcUrl" :after="selected.result.url"
                     :width="selected.result.width" :height="selected.result.height" />
        <div v-else-if="selected.status === 'error'" class="banner error">{{ selected.error }}</div>
        <div v-else class="banner">
          <span class="spinner" aria-hidden="true"></span>
          {{ selected.status === 'running' ? `放大中 ${Math.round(selected.progress * 100)}%…` : '排隊中…' }}
          <span v-if="backend === 'wasm'" class="muted">（CPU 運算，大圖要等一下）</span>
        </div>
        <p v-if="selected.status === 'done'" class="dims">
          {{ selected.width }}×{{ selected.height }} → <strong>{{ selected.result.width }}×{{ selected.result.height }}</strong>（{{ selected.result.scale }}×）
        </p>
      </section>
    </template>

    <footer>
      圖片放大 · 所有運算都在瀏覽器內完成 ·
      模型 <a href="https://huggingface.co/Phips/4xNomosUni_span_multijpg">4xNomosUni SPAN</a> 由 Philip Hofmann 訓練（CC BY 4.0）·
      <a href="../zipeditor/">ZIP 編輯器</a> ·
      <a href="../">更多工具</a> ·
      <a href="https://github.com/mason276752/upscale">GitHub 原始碼</a>
    </footer>

    <div class="toast" :class="{ show: toastMsg }" role="status" aria-live="polite">
      <span>{{ toastMsg }}</span>
    </div>

    <input ref="fileInput" type="file" accept="image/*,.heic,.heif" multiple hidden @change="onPick" />
  </div>
</template>

<style scoped>
.top .badge {
  padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line);
  color: var(--muted); font-size: 12px; font-weight: 600; white-space: nowrap;
}
.top .badge.webgpu { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); color: var(--accent); }

.settings { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px; padding: 10px 14px; }
.field { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.label { font-weight: 600; font-size: 14px; }
.note { color: var(--muted); font-size: 13px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.seg button {
  min-width: 52px; min-height: 36px; border: 0; background: var(--panel); padding: 6px 14px; color: var(--muted);
  font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
}
.seg button + button { border-left: 1px solid var(--line); }
.seg button.on { background: var(--accent-soft); color: var(--accent); }
.start { margin-top: 12px; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin: 0; padding: 0; list-style: none; }
.grid li { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 12px; }
.grid li.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.thumb {
  position: relative; display: block; width: 100%; aspect-ratio: 4 / 3; padding: 0; overflow: hidden;
  border: 0; border-radius: 8px; background: var(--checker); cursor: pointer;
}
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.bar { position: absolute; left: 8px; right: 8px; bottom: 8px; height: 5px; border-radius: 3px; background: rgb(0 0 0 / .35); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--accent-strong); transition: width .2s; }
.meta { display: grid; min-width: 0; }
.meta b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.error .status { color: var(--danger); }
.spinner.small { width: 11px; height: 11px; border-width: 2px; }
.row-btns { display: flex; justify-content: flex-end; gap: 6px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.muted { color: var(--muted); font-size: 13px; }
.title { overflow-wrap: anywhere; }
.dims { margin: 10px 0 0; color: var(--muted); font-size: 13px; }
.dims strong { color: var(--text); }
</style>
