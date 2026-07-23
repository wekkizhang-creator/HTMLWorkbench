import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

import { parseZipWebsite } from "../lib/zip.mjs";

function buildZipEntry({ content, declaredSize = content.length, pathname = "index.html" }) {
  const name = Buffer.from(pathname);
  const compressed = deflateRawSync(content);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);

  const centralOffset = local.length + name.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, name, compressed, central, name, end]);
}

test("ZIP extraction rejects content larger than its declared uncompressed size", () => {
  const zip = buildZipEntry({
    content: Buffer.alloc(1024, "a"),
    declaredSize: 1
  });

  assert.throws(
    () => parseZipWebsite(zip),
    /decompressed size|size limit/i
  );
});
