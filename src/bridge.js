// 和同網域（mason276752.github.io）的其他工具互傳檔案。協定與 zipeditor/src/bridge.ts、
// paste2jpg 相同——每個工具監聽以自己命名的 BroadcastChannel：
//
//   {type:'ping'}                          任何人 → 工具   「有誰開著？」
//   {type:'ready', id} / {type:'bye', id}  工具的分頁     宣告自己開著／要關閉
//   {type:'files', to, id, files, from?, origins?}
//                                          把檔案交給某個工具的某一個分頁（ZIP 編輯器或其他工具傳來）
//   {type:'zip', to, id, file, from?}      這個工具把結果打包交給 ZIP 編輯器的某一個分頁
//   {type:'update', to, id, key, output, file, from}
//                                          把某個檔案最新的處理結果傳回它的來源
//   {type:'received', id}                  收件分頁的回條
//
// 投遞一律指定 `to` 某一個分頁，同一個工具開了兩份時才不會兩邊都收。
//
// origins[i] = {app, to, key}：files[i] 從哪裡來。處理好、之後每次修改，都用 'update' 把結果傳回
// 那個分頁（帶同一個 key）；`output` 是這份結果的代號，同一份結果的新版本會取代舊的。
// 把檔案再轉給別的工具時 origin 跟著傳過去，結果一樣回到最初的來源。
// 這個檔案在 upscale／removebg／audiospeed／pdfcompress 幾個 repo 裡只差 SELF 一行。

export const SELF = 'upscale'

/** @typedef {{ app: string, to: string, key: string }} Origin 檔案的來源：結果要傳回哪個分頁 */

/** 會傳檔案過去的工具：ZIP 編輯器收 ZIP，其他收零散的檔案。 */
export const TOOLS = {
  zipeditor: { url: '../zipeditor/', label: 'ZIP 編輯器' },
  paste2jpg: { url: '../paste2jpg/', label: 'Paste → JPG' },
  upscale: { url: '../upscale/', label: '圖片放大' },
  removebg: { url: '../removebg/', label: '去背' },
}

export const toolLabel = (name) => TOOLS[name]?.label || name || '其他分頁'

export const bridgeSupported = typeof BroadcastChannel !== 'undefined'
const tabId = bridgeSupported ? crypto.randomUUID() : ''

/** 各工具開著的分頁（最近宣告的排最後）。 */
const peers = new Map()
function peer(name) {
  let p = peers.get(name)
  if (!p) {
    const channel = new BroadcastChannel(name)
    const tabs = new Set()
    channel.addEventListener('message', (e) => {
      const m = e.data
      if (m?.type === 'ready') {
        tabs.delete(m.id)
        tabs.add(m.id)
      } else if (m?.type === 'bye') {
        tabs.delete(m.id)
      }
    })
    channel.postMessage({ type: 'ping' })
    p = { channel, tabs }
    peers.set(name, p)
  }
  return p
}

/** `channel` 上第一則通過 `test` 的訊息；`ms` 毫秒內沒等到就回 null。 */
function nextMessage(channel, test, ms) {
  return new Promise((resolve) => {
    const finish = (m) => {
      clearTimeout(timer)
      channel.removeEventListener('message', onMessage)
      resolve(m)
    }
    const onMessage = (e) => {
      if (e.data && test(e.data)) finish(e.data)
    }
    const timer = setTimeout(() => finish(null), ms)
    channel.addEventListener('message', onMessage)
  })
}

/**
 * 把 `build` 做出來的訊息交給 `name` 這個工具。
 *
 * **要在點擊的當下同步呼叫**：對方沒開的話這裡會開新分頁，而彈出視窗攔截只放行
 * 使用者手勢裡開的分頁。`build` 在那之後才打包。
 *
 * @param {string} name 「TOOLS」裡的工具
 * @param {() => Promise<object>} build
 * @returns {Promise<'sent'|'blocked'|'no-answer'>}
 */
function deliver(name, build) {
  const p = peer(name)
  if (!p.tabs.size && !window.open(TOOLS[name].url, name)) return Promise.resolve('blocked')
  return (async () => {
    const msg = await build()
    // 剛開的分頁可能在打包的這段時間已經宣告過自己了。
    let to = [...p.tabs].pop()
    if (!to) to = (await nextMessage(p.channel, (m) => m.type === 'ready', 30_000))?.id
    if (!to) return 'no-answer'
    const id = crypto.randomUUID()
    const ack = nextMessage(p.channel, (m) => m.type === 'received' && m.id === id, 5000)
    p.channel.postMessage({ ...msg, id, to, from: SELF })
    if (await ack) return 'sent'
    p.tabs.delete(to) // 關掉了卻沒說 bye；下次傳送會開新分頁
    return 'no-answer'
  })()
}

/**
 * 把結果（一個 ZIP）傳給 ZIP 編輯器。和 `sendFiles` 一樣要在點擊的當下同步呼叫。
 *
 * @param {() => Promise<File>} build
 */
export function sendToEditor(build) {
  return deliver('zipeditor', async () => ({ type: 'zip', file: await build() }))
}

/**
 * 把檔案直接傳給另一個工具（例如去背的結果傳到圖片放大），不經過 ZIP 編輯器。
 * `origins[i]` 是 files[i] 原本的來源（沒有就是 null），對方的結果會傳回那裡。
 *
 * @param {string} name 「TOOLS」裡的工具
 * @param {() => Promise<{ files: File[], origins?: (Origin | null)[] }>} build
 */
export function sendFiles(name, build) {
  return deliver(name, async () => ({ type: 'files', ...(await build()) }))
}

// 傳回結果的防抖＋節流：同一份結果連續改（去背一筆一筆修補、拖品質滑桿…）時不要每次都傳。
// 閒置之後的第一次改動馬上傳；之後停手 RESULT_QUIET 毫秒才傳最新的一版，
// 一直改不停的話最多每 RESULT_MAX_WAIT 毫秒也傳一次。
const RESULT_QUIET = 800
const RESULT_MAX_WAIT = 3000
const outgoing = new Map() // 每份結果一筆：{ origin, output, file, timer, since, last, waiters }

/**
 * 把處理結果傳回檔案的來源（會防抖、節流，見上面）。來源的分頁已經關掉就回 false（不會開新分頁）。
 * 被後來的版本併掉的呼叫，拿到的是最後實際傳出那一版的結果。
 *
 * @param {Origin} origin
 * @param {string} output 這份結果的代號；同一份結果改過再傳，來源會取代舊的
 * @param {File} file
 * @returns {Promise<boolean>}
 */
export function sendResult(origin, output, file) {
  const k = JSON.stringify([origin.app, origin.to, origin.key, output])
  let r = outgoing.get(k)
  if (!r) outgoing.set(k, (r = { since: 0, last: 0, waiters: [] }))
  Object.assign(r, { origin, output, file })
  const done = new Promise((resolve) => r.waiters.push(resolve))
  clearTimeout(r.timer)
  const now = Date.now()
  if (!r.since && now - r.last >= RESULT_QUIET) {
    flushResult(r)
  } else {
    r.since ||= now
    r.timer = setTimeout(() => flushResult(r), Math.min(RESULT_QUIET, r.since + RESULT_MAX_WAIT - now))
  }
  return done
}

async function flushResult(r) {
  clearTimeout(r.timer)
  const { origin, output, file, waiters } = r
  Object.assign(r, { file: null, since: 0, last: Date.now(), waiters: [] })
  const p = peer(origin.app)
  const id = crypto.randomUUID()
  const ack = nextMessage(p.channel, (m) => m.type === 'received' && m.id === id, 5000)
  p.channel.postMessage({ type: 'update', id, to: origin.to, key: origin.key, output, file, from: SELF })
  const ok = !!(await ack)
  for (const resolve of waiters) resolve(ok)
}

/**
 * 宣告這個分頁開著，並把別的工具傳來的檔案交給 `onFiles`（`origins[i]` 是 files[i] 的來源或 null）。
 * 回傳停止監聽的函式。
 *
 * @param {(files: File[], from?: string, origins?: (Origin | null)[]) => void} onFiles
 */
export function listen(onFiles) {
  if (!bridgeSupported) return () => {}
  // 先知道其他工具有沒有開著：第一次傳送就不必等，也不會在對方其實開著時又開一個分頁
  for (const name of Object.keys(TOOLS)) if (name !== SELF) peer(name)
  const channel = new BroadcastChannel(SELF)
  const announce = () => channel.postMessage({ type: 'ready', id: tabId })
  const bye = () => channel.postMessage({ type: 'bye', id: tabId })
  const onShow = (e) => {
    if (e.persisted) announce()
  }
  channel.onmessage = (e) => {
    const m = e.data
    if (m?.type === 'ping') {
      announce()
    } else if (m?.type === 'files' && m.to === tabId && Array.isArray(m.files)) {
      channel.postMessage({ type: 'received', id: m.id })
      const got = m.files.map((f, i) => [f, m.origins?.[i] ?? null]).filter(([f]) => f instanceof File)
      onFiles(got.map(([f]) => f), m.from, got.map(([, o]) => o))
    }
  }
  window.addEventListener('pagehide', bye)
  window.addEventListener('pageshow', onShow)
  announce()
  return () => {
    window.removeEventListener('pagehide', bye)
    window.removeEventListener('pageshow', onShow)
    bye()
    channel.close()
  }
}
