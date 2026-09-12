export function rasterMime(bytes) {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const text = String.fromCharCode(...bytes.slice(0, 12));
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8) === "WEBP") return "image/webp";
  throw new Error("请选择 PNG、JPEG、WebP 或 GIF 图片。");
}

export async function readRasterImage(file) {
  if (!file || !file.size || file.size > 8 * 1024 * 1024) throw new Error("图片不能为空，且不能超过 8 MB。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = rasterMime(bytes);
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
  const image = new Image();
  image.src = data;
  try { await image.decode(); } catch { throw new Error("图片无法解码，请重新选择。"); }
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) {
    throw new Error("图片尺寸过大，请先缩小到 4000 万像素以内。");
  }
  return data;
}

export function imageReplacementCommand(image, data) {
  const elements = [image, ...(image.parentElement?.tagName === "PICTURE" ? [...image.parentElement.querySelectorAll("source")] : [])];
  const snapshots = elements.map(element => ({ element, attrs: ["src", "srcset", "sizes"].map(name => [name, element.getAttribute(name)]) }));
  return {
    redo() {
      for (const element of elements) { element.removeAttribute("srcset"); element.removeAttribute("sizes"); }
      image.setAttribute("src", data);
    },
    undo() {
      for (const { element, attrs } of snapshots) for (const [name, value] of attrs) {
        if (value === null) element.removeAttribute(name);
        else element.setAttribute(name, value);
      }
    }
  };
}
