import assert from "node:assert/strict";
import test from "node:test";
import { sampleDesktopSceneColor } from "../public/pinshot/scene.mjs";

test("color sampler renders the local scene and returns the sampled pixel as hex", () => {
  const sampled = [];
  const context = {
    save() {},
    restore() {},
    translate() {},
    fillRect() {},
    fillText() {},
    createLinearGradient() { return { addColorStop() {} }; },
    getImageData(x, y, width, height) {
      sampled.push({ x, y, width, height });
      return { data: [12, 34, 56, 255] };
    }
  };
  const surface = { width: 0, height: 0, getContext: () => context };
  const documentRef = { createElement: (tagName) => {
    assert.equal(tagName, "canvas");
    return surface;
  } };

  assert.equal(sampleDesktopSceneColor(documentRef, { x: 999, y: -4, width: 800, height: 600 }), "#0C2238");
  assert.equal(surface.width, 800);
  assert.equal(surface.height, 600);
  assert.deepEqual(sampled, [{ x: 799, y: 0, width: 1, height: 1 }]);
});
