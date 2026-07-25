import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Blob downloads bypass stale cached upload bytes", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-blob-fresh-"));
  const previousDataDir = process.env.HTML_WORKBENCH_DATA_DIR;
  const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousVercel = process.env.VERCEL;

  process.env.HTML_WORKBENCH_DATA_DIR = dataDir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;

  try {
    const storage = await import(`../lib/storage.mjs?blob-fresh-test=${Date.now()}`);
    const storagePath = "uploads/00000000-0000-4000-8000-000000000003.html";
    const staleBytes = Buffer.from("<h1>before replacement</h1>");
    const currentBytes = Buffer.from("<h1>after replacement</h1>");
    const calls = [];
    const blobSdk = {
      async get(pathname, options = {}) {
        calls.push({ pathname, options });
        const bytes = options.useCache === false ? currentBytes : staleBytes;
        return {
          statusCode: 200,
          stream: new Blob([bytes]).stream(),
          blob: { size: bytes.length }
        };
      }
    };

    const download = await storage.getDownloadContent({
      id: "00000000-0000-4000-8000-000000000003",
      uploadKind: "html",
      blobPath: storagePath
    }, { blobSdk });

    assert.ok(download);
    assert.deepEqual(
      Buffer.from(await new Response(download.body).arrayBuffer()),
      currentBytes
    );
    assert.deepEqual(calls, [{
      pathname: storagePath,
      options: { access: "private", useCache: false }
    }]);
  } finally {
    if (previousDataDir === undefined) delete process.env.HTML_WORKBENCH_DATA_DIR;
    else process.env.HTML_WORKBENCH_DATA_DIR = previousDataDir;
    if (previousBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    await fs.rm(dataDir, { force: true, recursive: true });
  }
});

test("local downloads expose a stream instead of buffering the whole file", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-stream-"));
  const previousDataDir = process.env.HTML_WORKBENCH_DATA_DIR;
  const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousVercel = process.env.VERCEL;

  process.env.HTML_WORKBENCH_DATA_DIR = dataDir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;

  try {
    const storage = await import(`../lib/storage.mjs?stream-test=${Date.now()}`);
    const id = "00000000-0000-4000-8000-000000000001";
    const expected = Buffer.from("streamed HTML content");
    const stored = await storage.saveUpload(id, expected);
    const download = await storage.getDownloadContent({
      id,
      uploadKind: "html",
      blobPath: stored.pathname
    });

    assert.ok(download);
    assert.equal(Buffer.isBuffer(download.body), false);
    assert.equal(typeof download.body.getReader, "function");
    assert.deepEqual(
      Buffer.from(await new Response(download.body).arrayBuffer()),
      expected
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.HTML_WORKBENCH_DATA_DIR;
    else process.env.HTML_WORKBENCH_DATA_DIR = previousDataDir;
    if (previousBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    await fs.rm(dataDir, { force: true, recursive: true });
  }
});
test("an opened local download keeps a consistent snapshot during replacement", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-snapshot-"));
  const previousDataDir = process.env.HTML_WORKBENCH_DATA_DIR;
  const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousVercel = process.env.VERCEL;

  process.env.HTML_WORKBENCH_DATA_DIR = dataDir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;

  try {
    const storage = await import(`../lib/storage.mjs?snapshot-test=${Date.now()}`);
    const id = "00000000-0000-4000-8000-000000000002";
    const original = Buffer.alloc(1024 * 1024, "a");
    const replacement = Buffer.alloc(128 * 1024, "b");
    const stored = await storage.saveUpload(id, original);
    const download = await storage.getDownloadContent({
      id,
      uploadKind: "html",
      blobPath: stored.pathname
    });

    const replacementPromise = storage.saveUpload(id, replacement, { allowOverwrite: true });
    const downloaded = Buffer.from(await new Response(download.body).arrayBuffer());
    await replacementPromise;

    assert.equal(download.contentLength, original.length);
    assert.deepEqual(downloaded, original);
  } finally {
    if (previousDataDir === undefined) delete process.env.HTML_WORKBENCH_DATA_DIR;
    else process.env.HTML_WORKBENCH_DATA_DIR = previousDataDir;
    if (previousBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    await fs.rm(dataDir, { force: true, recursive: true });
  }
});
test("busy local file operations fail within a bounded time", async () => {
  const storage = await import(`../lib/storage.mjs?busy-test=${Date.now()}`);
  const startedAt = Date.now();

  await assert.rejects(
    storage.retryBusyLocalOperation(async () => {
      const error = new Error("busy");
      error.code = "EPERM";
      throw error;
    }, 25),
    (error) => error?.status === 409
  );

  assert.ok(Date.now() - startedAt < 500);
});