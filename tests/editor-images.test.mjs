import test from "node:test";
import assert from "node:assert/strict";
import { rasterMime, imageReplacementCommand } from "../public/editor-images.mjs";

test("raster replacement identifies bytes and rejects SVG or unknown content", () => {
  assert.equal(rasterMime(Uint8Array.from([137,80,78,71,13,10,26,10])), "image/png");
  assert.equal(rasterMime(Uint8Array.from([255,216,255,0])), "image/jpeg");
  assert.equal(rasterMime(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.equal(rasterMime(new TextEncoder().encode("RIFFxxxxWEBP")), "image/webp");
  assert.throws(() => rasterMime(new TextEncoder().encode("<svg></svg>")));
});

test("image history preserves responsive attributes and restores picture sources", () => {
  const element = (attrs) => ({ attrs: new Map(Object.entries(attrs)), getAttribute(n) { return this.attrs.get(n) ?? null; }, setAttribute(n, v) { this.attrs.set(n, v); }, removeAttribute(n) { this.attrs.delete(n); } });
  const image = element({ src: "old.png", srcset: "old@2x.png 2x", width: "400" });
  const source = element({ srcset: "mobile.png", sizes: "50vw" });
  image.parentElement = { tagName: "PICTURE", querySelectorAll: () => [source] };
  const command = imageReplacementCommand(image, "data:image/png;base64,new");
  command.redo();
  assert.equal(image.getAttribute("srcset"), null);
  assert.equal(source.getAttribute("srcset"), null);
  assert.equal(image.getAttribute("width"), "400");
  command.undo();
  assert.equal(image.getAttribute("src"), "old.png");
  assert.equal(source.getAttribute("srcset"), "mobile.png");
  command.redo();
  assert.equal(image.getAttribute("src"), "data:image/png;base64,new");
});
