// 圖片解碼與編碼（主執行緒，要用到 canvas）。

/** 把檔案解碼成可以畫進 canvas 的東西；createImageBitmap 不吃的（例如 SVG）改用 <img>。 */
async function load(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return img
    } catch {
      throw new Error('瀏覽器解不開這個格式')
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

const dims = (src) => [src.naturalWidth || src.width, src.naturalHeight || src.height]

/**
 * 解碼成 RGBA。`image` 留著給 `scaledAlpha` 用（透明圖的 alpha 另外放大）。
 *
 * @returns {Promise<{image: CanvasImageSource, width: number, height: number, pixels: Uint8ClampedArray, hasAlpha: boolean}>}
 */
export async function decodeImage(file) {
  const image = await load(file)
  const [width, height] = dims(image)
  if (!width || !height) throw new Error('圖片尺寸為 0')
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(image, 0, 0)
  const pixels = g.getImageData(0, 0, width, height).data
  let hasAlpha = false
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] < 255) {
      hasAlpha = true
      break
    }
  }
  return { image, width, height, pixels, hasAlpha }
}

/**
 * 透明圖：SPAN 只放大 RGB，alpha 交給瀏覽器的高品質縮放，再合回結果。
 * 直接改寫 `pixels` 的 alpha。
 */
export function applyScaledAlpha(image, pixels, width, height) {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d', { willReadFrequently: true })
  g.imageSmoothingQuality = 'high'
  g.drawImage(image, 0, 0, width, height)
  const a = g.getImageData(0, 0, width, height).data
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = a[i]
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片太大，瀏覽器無法輸出'))), type, quality),
  )
}

/** RGBA → 圖檔。JPG 沒有透明，先鋪白底（不然透明處會變黑）。 */
export async function encodePixels(pixels, width, height, type, quality = 0.92) {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d')
  if (!g) throw new Error('圖片太大，瀏覽器無法建立畫布')
  g.putImageData(new ImageData(pixels, width, height), 0, 0)
  if (type === 'image/jpeg') {
    g.globalCompositeOperation = 'destination-over'
    g.fillStyle = '#fff'
    g.fillRect(0, 0, width, height)
  }
  const blob = await toBlob(c, type, quality)
  c.width = c.height = 0 // 大畫布立刻釋放，不等 GC
  return blob
}

/** 換輸出格式：把已編碼的結果再解一次、重新編碼。 */
export async function reencode(blob, type, quality = 0.92) {
  const image = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = image.width
  c.height = image.height
  const g = c.getContext('2d')
  if (type === 'image/jpeg') {
    g.fillStyle = '#fff'
    g.fillRect(0, 0, c.width, c.height)
  }
  g.drawImage(image, 0, 0)
  image.close()
  const out = await toBlob(c, type, quality)
  c.width = c.height = 0
  return out
}

export const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
