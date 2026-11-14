<script setup>
defineProps({ name: { type: String, required: true } })
</script>

<script>
// 24×24 線條圖示（與 zipeditor 同一套畫法）。
const PATHS = {
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  send: 'M5 12h13M13 6l6 6-6 6',
  x: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3',
  plus: 'M12 5v14M5 12h14',
  image: 'M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM4 16l5-5 4 4 2-2 5 5M15.5 8.5h.01',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5M9 9l-5-5M15 9l5-5M9 15l-5 5M15 15l5 5',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
}
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="PATHS[name]" />
  </svg>
</template>
