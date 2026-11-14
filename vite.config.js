import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/upscale/',
  // 放大跑在 module worker 裡（見 src/upscale/）。
  worker: { format: 'es' },
  // onnxruntime-web 用 `new URL('….wasm', import.meta.url)` 找它的執行檔，正式建置時
  // Vite 會把它當成資源一起輸出；開發時預先打包會弄斷這個相對路徑，所以排除。
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  test: {
    include: ['src/**/*.test.mjs'],
  },
})
