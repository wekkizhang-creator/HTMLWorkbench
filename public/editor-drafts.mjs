const DATABASE = "hwb-editor-drafts";
const STORE = "drafts";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HTML_BYTES = 30 * 1024 * 1024;
const OPEN_TIMEOUT_MS = 1500;

function identity(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Invalid draft ${field}.`);
}

function timestamp(value, currentTime) {
  if (typeof value !== "number" || !Number.isFinite(value) || value > currentTime + 60_000) {
    throw new TypeError("Invalid draft updatedAt.");
  }
}

function snapshot(entry, currentTime) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Invalid draft entry.");
  const { documentId, ownerId, baseVersion, html, title, pageIndex, updatedAt } = entry;
  identity(documentId, "documentId");
  identity(ownerId, "ownerId");
  identity(baseVersion, "baseVersion");
  if (typeof html !== "string" || !html.length || html.length > MAX_HTML_BYTES ||
      new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
    throw new TypeError("Draft HTML must contain 1 to 30 MiB of UTF-8 data.");
  }
  if (typeof title !== "string") throw new TypeError("Invalid draft title.");
  if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new TypeError("Invalid draft pageIndex.");
  timestamp(updatedAt, currentTime);
  return { documentId, ownerId, baseVersion, html, title, pageIndex, updatedAt };
}

function storageError(action, error) {
  // Do not include browser messages or record contents in surfaced errors.
  const names = ["SecurityError", "QuotaExceededError", "AbortError", "InvalidStateError", "VersionError",
    "UnknownError", "NotFoundError", "ConstraintError", "DataError", "ReadOnlyError"];
  const name = names.includes(error?.name) ? error.name : "Error";
  return new Error(`Draft storage ${action} failed (${name}).`);
}

export function createDraftStore({ indexedDB = globalThis.indexedDB, now = Date.now } = {}) {
  let connection = null;
  let opening = null;

  function currentTime() {
    const value = now();
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Invalid draft clock.");
    return value;
  }

  function open() {
    if (connection) return Promise.resolve(connection);
    if (opening) return opening.promise;
    if (!indexedDB || typeof indexedDB.open !== "function") {
      return Promise.reject(new Error("Draft storage unavailable: IndexedDB is not available."));
    }
    const attempt = {};
    opening = attempt;
    attempt.promise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, db) => {
        if (settled) { db?.close(); return; }
        settled = true;
        clearTimeout(timer);
        if (opening === attempt) opening = null;
        if (error) reject(error);
        else { connection = db; resolve(db); }
      };
      const timer = setTimeout(() => finish(new Error("Draft storage open timed out.")), OPEN_TIMEOUT_MS);
      attempt.cancel = () => finish(new Error("Draft storage closed during open."));
      try {
        const request = indexedDB.open(DATABASE, 1);
        request.onblocked = () => finish(new Error("Draft storage open blocked by another connection."));
        request.onerror = () => finish(storageError("open", request.error));
        request.onupgradeneeded = () => {
          if (settled) { request.transaction.abort(); return; }
          try {
            if (!request.result.objectStoreNames.contains(STORE)) {
              request.result.createObjectStore(STORE, { keyPath: ["documentId", "ownerId"] });
            }
          } catch (error) {
            request.transaction.abort();
            finish(storageError("upgrade", error));
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          if (settled) { db.close(); return; }
          db.onversionchange = () => {
            db.close();
            if (connection === db) connection = null;
          };
          db.onclose = () => { if (connection === db) connection = null; };
          finish(null, db);
        };
      } catch (error) { finish(storageError("open", error)); }
    });
    return attempt.promise;
  }

  async function transact(action, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      let requestError;
      const fail = (error) => {
        try { tx?.abort(); } catch { /* The transaction may already have finished. */ }
        reject(storageError(action, error));
      };
      const guard = (callback) => (event) => {
        try { callback(event); } catch (error) { fail(error); }
      };
      try {
        tx = db.transaction(STORE, "readwrite");
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(storageError(action, requestError ?? tx.error ?? { name: "AbortError" }));
        tx.onerror = (event) => { requestError = event.target?.error ?? tx.error; };
        work(tx.objectStore(STORE), (value) => { result = value; }, guard);
      } catch (error) { fail(error); }
    });
  }

  return {
    async list(documentId) {
      identity(documentId, "documentId");
      const time = currentTime();
      return transact("list", (store, done, guard) => {
        const entries = [];
        const request = store.openCursor();
        request.onsuccess = guard(() => {
          const cursor = request.result;
          if (!cursor) {
            done(entries.sort((a, b) => b.updatedAt - a.updatedAt));
            return;
          }
          const record = cursor.value;
          if (Number.isFinite(record?.updatedAt) && record.updatedAt <= time - RETENTION_MS) {
            cursor.delete();
          } else if (record?.documentId === documentId && record.schemaVersion === 1) {
            try { entries.push(snapshot(record, time)); } catch { /* Ignore invalid stored records. */ }
          }
          cursor.continue();
        });
      });
    },

    async write(entry) {
      const value = snapshot(entry, currentTime());
      return transact("write", (store, done, guard) => {
        const request = store.get([value.documentId, value.ownerId]);
        request.onsuccess = guard(() => {
          if (Number.isFinite(request.result?.updatedAt) && request.result.updatedAt > value.updatedAt) {
            done(false);
            return;
          }
          store.put({ ...value, schemaVersion: 1 });
          done(true);
        });
      });
    },

    async remove(documentId, ownerId, expectedUpdatedAt) {
      identity(documentId, "documentId");
      identity(ownerId, "ownerId");
      if (expectedUpdatedAt !== undefined) timestamp(expectedUpdatedAt, currentTime());
      return transact("remove", (store, done, guard) => {
        const key = [documentId, ownerId];
        const request = store.get(key);
        request.onsuccess = guard(() => {
          if (!request.result || (expectedUpdatedAt !== undefined && request.result.updatedAt !== expectedUpdatedAt)) {
            done(false);
            return;
          }
          store.delete(key);
          done(true);
        });
      });
    },

    close() {
      opening?.cancel();
      connection?.close();
      connection = null;
    }
  };
}
