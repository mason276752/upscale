<script setup>
// 前後對照：兩張圖都用**放大後的尺寸**排版。原圖交給瀏覽器內插撐大，就是「不做 AI 放大」
// 的誠實基準線，兩邊像素一一對應，拉桿掃過去差異才看得出來。
//
// 移植自 rust-ai-webtool 的 UpscalePanel；那邊踩過的坑（圖片原生拖曳搶走手勢、
// 疊圖過度約束對不齊）的修法都保留在下面的註解裡。
import { ref } from 'vue'

const props = defineProps({
  before: { type: String, required: true },
  after: { type: String, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
})

const split = ref(50) // 分隔線位置（%）
const zoom = ref('fit') // 'fit' | 'full'（1:1 = 輸出解析度）
const viewport = ref(null)
let dragging = false

function setSplitFrom(ev) {
  const box = viewport.value?.getBoundingClientRect()
  if (!box?.width) return
  split.value = Math.min(100, Math.max(0, ((ev.clientX - box.left) / box.width) * 100))
}
function onDown(ev) {
  dragging = true
  // 先更新位置再抓 pointer capture：capture 在某些瀏覽器／裝置會丟例外，
  // 擺在前面的話連「按下就跳過去」都會一起失效。
  setSplitFrom(ev)
  try { viewport.value?.setPointerCapture?.(ev.pointerId) } catch { /* 抓不到就算了 */ }
}
function onMove(ev) {
  if (dragging) setSplitFrom(ev)
}
function onUp(ev) {
  dragging = false
  try { viewport.value?.releasePointerCapture?.(ev.pointerId) } catch { /* 沒抓到過就沒得釋放 */ }
}
</script>

<template>
  <div class="compare">
    <div class="view-tools">
      <div class="seg">
        <button type="button" :class="{ on: zoom === 'fit' }" @click="zoom = 'fit'">符合寬度</button>
        <button type="button" :class="{ on: zoom === 'full' }" @click="zoom = 'full'">1:1</button>
      </div>
      <span class="hint">在圖上按住拖曳移動分隔線；細節差異在「1:1」最明顯</span>
    </div>
    <div class="scroller" :class="{ full: zoom === 'full' }">
      <div
        ref="viewport"
        class="viewport"
        :style="zoom === 'full' ? { width: props.width + 'px' } : null"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
      >
        <!-- 結果在底層、原圖疊在上面並從右側裁掉，分隔線左邊看到的就是原圖。
             draggable="false"：不然在圖上按住拖曳會觸發瀏覽器內建的「拖曳圖片」，
             整個手勢被搶走（收到 pointercancel），分隔線就拖不動了。 -->
        <img class="layer" :src="after" :width="width" :height="height" alt="放大結果" draggable="false" />
        <img class="layer before" :src="before" :width="width" :height="height" alt="原圖" draggable="false"
             :style="{ clipPath: `inset(0 ${100 - split}% 0 0)` }" />
        <div class="divider" :style="{ left: split + '%' }"><span class="knob"></span></div>
        <span class="tag left">原圖</span>
        <span class="tag right">放大結果</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.view-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 10px; }
.hint { color: var(--muted); font-size: 13px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.seg button {
  border: 0; background: var(--panel); padding: 6px 14px; color: var(--muted);
  font: inherit; font-size: 13px; cursor: pointer;
}
.seg button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }

/* 'fit' 讓圖縮到欄寬；'full' 改成可捲動的 1:1（輸出很大，一定要能捲） */
.scroller { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--checker); }
.scroller.full { overflow: auto; max-height: 75vh; }
.viewport { position: relative; margin: 0 auto; line-height: 0; touch-action: none; cursor: ew-resize; user-select: none; }
/* 兩張圖都以容器寬度排版（1:1 模式下容器寬 = 輸出寬），彼此嚴格對齊。
   pointer-events:none 讓整個拖曳手勢只落在 .viewport 上。 */
.viewport .layer { display: block; width: 100%; height: auto; pointer-events: none; -webkit-user-drag: none; }
/* 疊在上面的原圖只給 top/left（不是 inset:0）：同時指定 left+right+width 會過度約束，
   兩層就對不齊了。保持預設的平滑內插——那才是「沒有 AI」的誠實對照組。 */
.viewport .layer.before { position: absolute; top: 0; left: 0; image-rendering: auto; }
.divider {
  position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: rgba(255, 255, 255, .9); box-shadow: 0 0 0 1px rgba(0, 0, 0, .55); pointer-events: none;
}
.knob {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 26px; height: 26px; border-radius: 50%;
  background: rgba(255, 255, 255, .95); box-shadow: 0 0 0 1px rgba(0, 0, 0, .55);
}
.tag {
  position: absolute; top: 8px; padding: 2px 8px; border-radius: 6px; pointer-events: none;
  background: rgba(0, 0, 0, .55); color: #fff; font-size: 12px; line-height: 1.6;
}
.tag.left { left: 8px; }
.tag.right { right: 8px; }
</style>
