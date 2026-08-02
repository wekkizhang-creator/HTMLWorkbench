import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const screenshots = [
  ["qa-screenshots/pinshot-1366x768.png", 1366, 768],
  ["qa-screenshots/pinshot-1440x900.png", 1440, 900],
  ["qa-screenshots/pinshot-1920x1080.png", 1920, 1080]
];

test("PinShot acceptance screenshots are genuine PNGs at their named viewport dimensions", async () => {
  for (const [file, width, height] of screenshots) {
    const image = await readFile(file);
    assert.deepEqual(image.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE, `${file} must use the PNG signature`);
    assert.equal(image.readUInt32BE(16), width, `${file} width`);
    assert.equal(image.readUInt32BE(20), height, `${file} height`);
  }
});
