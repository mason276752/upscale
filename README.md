# 圖片放大

用 AI 在瀏覽器裡把圖片放大 4 倍或 2 倍、補回細節。純前端，圖片不會上傳到任何伺服器。

👉 https://mason276752.github.io/upscale/

## 功能

- **AI 放大**：SPAN 超解析度模型，4×（通用照片／插畫，耐得住 JPEG 雜訊）或 2×（輸出檔小很多）
- **前後對照**：拖曳分隔線比較原圖與結果，可切換 1:1 看細節
- **批次處理**：一次放很多張（選檔、拖曳、貼上都可以），依序放大
- **輸出**：PNG（無損）、JPG、WebP；透明 PNG 的 alpha 另外平滑放大後保留
- **WebGPU 加速**：有 WebGPU 的瀏覽器用顯示卡，沒有就退回 CPU（WASM），大圖會比較慢

## 和 ZIP 編輯器串接

工具都放在 `mason276752.github.io` 底下，屬於同一個 origin，可以用 [BroadcastChannel](https://developer.mozilla.org/docs/Web/API/BroadcastChannel) 互傳檔案：

- 在 [ZIP 編輯器](https://mason276752.github.io/zipeditor/) 勾選圖片（或在預覽裡）按「圖片放大」，檔案會傳過來（`{type:'files'}`）
- 這裡按「傳到 ZIP 編輯器」，結果打包成 ZIP 傳回去（`{type:'zip'}`），可以合併到目前的資料夾

對方的分頁沒開的話會自動開新分頁。協定見 [`src/bridge.js`](src/bridge.js)，與 zipeditor、paste2jpg 相同。

## 模型與推論

- 權重：Philip Hofmann 的 [4xNomosUni_span_multijpg](https://huggingface.co/Phips/4xNomosUni_span_multijpg) 與 [2xNomosUni_span_multijpg_ldl](https://huggingface.co/Phips/2xNomosUni_span_multijpg_ldl)（與 rust-ai-webtool（私人專案） 用的同一組）
- `public/models/*.onnx` 由 [`tools/export-onnx.py`](tools/export-onnx.py) 轉出（各約 1.7MB）：先跑一次前向讓 Conv3XC 的融合權重寫回 `eval_conv`，再匯出，並與 PyTorch 逐像素比對（8-bit 最多差 1）
- 推論用 [onnxruntime-web](https://onnxruntime.ai/)，在 Web Worker 裡分塊跑：每塊 256×256，外擴 21 像素（網路的感受野）再裁掉，拼出來與整張一次跑一致，沒有接縫（分塊邏輯移植自 rust-ai-webtool，見 `src/upscale/tiles.js`）

重新轉出模型：

```sh
pip install torch spandrel onnx onnxruntime numpy
python tools/export-onnx.py 4xNomosUni_span_multijpg.safetensors public/models/span-4x.onnx
python tools/export-onnx.py 2xNomosUni_span_multijpg_ldl.safetensors public/models/span-2x.onnx
```

## 開發

```sh
npm install
npm run dev        # http://localhost:5173/upscale/
npm test
npm run build      # 輸出到 dist/
```

推到 `main` 後，GitHub Actions 會跑測試、建置並發布到 GitHub Pages。

## 授權

- 模型權重：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，作者 Philip Hofmann（頁尾有標註）
- [onnxruntime-web](https://github.com/microsoft/onnxruntime)（MIT）、[Vue](https://vuejs.org/)（MIT）
