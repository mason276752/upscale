// 和同網域（mason276752.github.io）的其他工具互傳檔案。協定與 zipeditor/src/bridge.ts、
// paste2jpg 相同——每個工具監聽以自己命名的 BroadcastChannel：
//
//   {type:'ping'}                          任何人 → 工具   「有誰開著？」
//   {type:'ready', id} / {type:'bye', id}  工具的分頁     宣告自己開著／要關閉
//   {type:'files', to, id, files, from?}   把檔案交給某個工具的某一個分頁（ZIP 編輯器或其他工具傳來）
//   {type:'zip', to, id, file, from?}      這個工具把結果打包交給 ZIP 編輯器的某一個分頁
//   {type:'received', id}                  收件分頁的回條
//
// 投遞一律指定 `to` 某一個分頁，同一個工具開了兩份時才不會兩邊都收。
// 這個檔案在 upscale／removebg／audiospeed／pdfcompress 幾個 repo 裡只差 SELF 一行。

export const SELF = 'upscale'

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
 *
 * @param {string} name 「TOOLS」裡的工具
 * @param {() => Promise<File[]>} build
 */
export function sendFiles(name, build) {
  return deliver(name, async () => ({ type: 'files', files: await build() }))
}

/**
 * 宣告這個分頁開著，並把別的工具傳來的檔案交給 `onFiles`。
 * 回傳停止監聽的函式。
 *
 * @param {(files: File[], from?: string) => void} onFiles
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
      onFiles(m.files.filter((f) => f instanceof File), m.from)
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
