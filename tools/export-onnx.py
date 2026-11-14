"""把 SPAN 放大權重（safetensors）轉成 ONNX，給瀏覽器裡的 onnxruntime-web 用。

用法：
    python tools/export-onnx.py <權重.safetensors> <輸出.onnx>

需求：torch、spandrel、onnx、onnxruntime、numpy

為什麼要先跑一次前向再匯出：SPAN 的 Conv3XC 訓練時是「1×1 → 3×3 → 1×1 ＋ 1×1 skip」
四條線性層，推論時融合成單一 3×3（`update_params()`）。權重檔裡存的 `eval_conv.*` 從來
沒被寫回過，是隨機初始化的垃圾值；spandrel 在 eval 模式的每次 forward 都會重算融合。
所以這裡先跑一次 forward，讓融合後的權重寫進 eval_conv，再匯出——匯出的圖就只剩單純
的 3×3 conv，比照訓練路徑跑四個 conv 快得多。最後拿 PyTorch 的結果逐張比對。
"""

import sys

import numpy as np
import onnx
import onnxruntime as ort
import spandrel
import torch


def main(src: str, dst: str) -> None:
    desc = spandrel.ModelLoader().load_from_file(src)
    net = desc.model.eval()
    print(f"架構 {desc.architecture.name}，{desc.scale}×")

    x = torch.rand(1, 3, 64, 48)
    with torch.no_grad():
        net(x)  # 觸發 Conv3XC 的融合（見檔頭）
        torch.onnx.export(
            net,
            x,
            dst,
            input_names=["input"],
            output_names=["output"],
            dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "oh", 3: "ow"}},
            opset_version=17,
            dynamo=False,
        )
    onnx.checker.check_model(onnx.load(dst))

    # 比對用平滑的合成圖，不用純雜訊：逐像素獨立的雜訊對這類網路是病態輸入，4× 那顆的
    # 激發值會被推到很大，連 PyTorch 自己 fp32 對 fp64 都差到 1e-2，比不出任何東西。
    # 照片等級的輸入上兩邊的差距跟 PyTorch fp32 本身的捨入誤差同級（~1e-5）。
    sess = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
    to8 = lambda a: np.clip(np.round(a * 255), 0, 255)
    worst = 0.0
    for h, w in [(64, 48), (37, 91), (128, 128)]:
        x = torch.nn.functional.interpolate(torch.rand(1, 3, h // 6 + 2, w // 6 + 2), size=(h, w), mode="bicubic").clamp(0, 1)
        with torch.no_grad():
            ref = net(x).numpy()
        out = sess.run(None, {"input": x.numpy()})[0]
        assert out.shape == ref.shape, (out.shape, ref.shape)
        err = float(np.abs(out - ref).max())
        px = float(np.abs(to8(out) - to8(ref)).max())
        worst = max(worst, px)
        print(f"  {h}×{w} → {out.shape[2]}×{out.shape[3]}，與 PyTorch 最大誤差 {err:.2e}（8-bit 最多差 {px:.0f}）")
    if worst > 1:
        sys.exit("8-bit 像素差超過 1，匯出的模型不可用")
    print(f"已寫入 {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
