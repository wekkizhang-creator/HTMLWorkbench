import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ELEMENT_IDS = [
  "clearButton", "copyLatestButton", "documentTypeCustom", "documentTypeSelect",
  "dropzone", "emptyState", "emptyText", "fileDetail", "fileInput", "fileName",
  "latestLink", "latestTime", "linkStatus", "logoutButton", "openLatestButton",
  "originText", "recordBody", "recordsError", "recordsErrorMessage", "recordsLoading", "recordsSkeleton",
  "recordsPanel", "refreshButton", "retryButton", "searchInput", "titleInput", "toast",
  "totalCount", "typeFilter", "uploadButton", "uploadButtonLabel", "uploadForm",
  "uploadProgress", "uploadProgressBar", "uploadProgressLabel", "uploadStatus", "loadMoreButton"
];

class FakeClassList {
  #values = new Set();

  add(...values) {
    values.forEach((value) => this.#values.add(value));
  }

  contains(value) {
    return this.#values.has(value);
  }

  remove(...values) {
    values.forEach((value) => this.#values.delete(value));
  }

  toggle(value, force) {
    const shouldAdd = force === undefined ? !this.#values.has(value) : Boolean(force);
    if (shouldAdd) {
      this.#values.add(value);
    } else {
      this.#values.delete(value);
    }
    return shouldAdd;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.disabled = false;
    this.files = [];
    this.hidden = false;
    this.href = "";
    this.innerHTMLSetCount = 0;
    this.listeners = new Map();
    this.style = {};
    this.tagName = tagName.toUpperCase();
    this.textContent = "";
    this.value = "";
    this._innerHTML = "";
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this.innerHTMLSetCount += 1;
    this._innerHTML = String(value);
    if (value === "") {
      this.children = [];
    }
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  async dispatch(type, overrides = {}) {
    const event = {
      dataTransfer: { files: [] },
      preventDefault() {},
      target: this,
      ...overrides
    };
    for (const listener of this.listeners.get(type) || []) {
      await listener(event);
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  toggleAttribute(name, force) {
    const shouldSet = force === undefined ? !this.attributes.has(name) : Boolean(force);
    if (shouldSet) {
      this.setAttribute(name, "");
    } else {
      this.removeAttribute(name);
    }
    return shouldSet;
  }

  closest(selector) {
    return this.closestTargets?.get(selector) || null;
  }

  click() {}
  focus() {}
  remove() {}
  select() {}
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

function recordsResponse(records, { nextCursor = null, hasMore = false } = {}) {
  return jsonResponse(200, {
    records,
    page: { nextCursor, hasMore }
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sampleRecord(overrides = {}) {
  return {
    description: "一份可检索的示例说明",
    documentType: "分析报告",
    hasPreviousVersion: false,
    id: "11111111-1111-4111-8111-111111111111",
    originalName: "seeded.html",
    size: 2048,
    title: "已加载的记录",
    uploadKind: "html",
    uploadedAt: "2026-07-23T08:00:00.000Z",
    url: "/view/11111111-1111-4111-8111-111111111111",
    ...overrides
  };
}

function sampleRecords(count, overridesForIndex = () => ({})) {
  return Array.from({ length: count }, (_, index) => sampleRecord({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    originalName: `record-${String(index).padStart(3, "0")}.html`,
    title: `Record ${String(index).padStart(3, "0")}`,
    uploadedAt: new Date(Date.UTC(2026, 6, 23, 8, 0, 0) - index * 1000).toISOString(),
    ...overridesForIndex(index)
  }));
}

async function waitFor(predicate, message = "condition was not met") {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function createAppHarness(initialResponses = []) {
  const source = await readFile("public/app.js", "utf8");
  const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, new FakeElement()]));
  elements.documentTypeSelect.value = "其他";
  elements.recordsError.hidden = true;
  elements.recordsPanel.setAttribute("aria-busy", "true");
  elements.typeFilter.value = "";
  elements.uploadButton.disabled = true;

  const customField = new FakeElement("label");
  const uploadGrid = new FakeElement();
  customField.closestTargets = new Map([[".upload-meta-grid", uploadGrid]]);
  elements.documentTypeCustom.closestTargets = new Map([[".field-control", customField]]);

  const responses = [...initialResponses];
  const requests = [];
  const timers = new Map();
  let currentTime = 0;
  let nextTimerId = 1;
  const fetch = async (url, options = {}) => {
    requests.push({ options, url });
    if (responses.length === 0) {
      throw new Error(`No fake response queued for ${url}`);
    }
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };

  const body = new FakeElement("body");
  const document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    execCommand: () => true,
    querySelector(selector) {
      return elements[selector.replace(/^#/, "")] || null;
    }
  };
  const location = {
    href: "http://example.test/",
    origin: "http://example.test",
    pathname: "/",
    search: ""
  };
  const window = {
    addEventListener() {},
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    confirm: () => true,
    isSecureContext: true,
    location,
    prompt: () => "",
    removeEventListener() {},
    setTimeout(callback, delay = 0) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, {
        callback,
        dueAt: currentTime + Number(delay || 0)
      });
      return timerId;
    }
  };
  const context = {
    AbortController,
    FormData,
    Intl,
    URL,
    URLSearchParams,
    document,
    fetch,
    navigator: {},
    window
  };

  vm.runInNewContext(source, context, { filename: "public/app.js" });
  return {
    advanceTimersBy(milliseconds) {
      currentTime += milliseconds;
      while (true) {
        const dueTimer = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= currentTime)
          .sort((first, second) => first[1].dueAt - second[1].dueAt)[0];
        if (!dueTimer) {
          break;
        }
        const [timerId, timer] = dueTimer;
        timers.delete(timerId);
        timer.callback();
      }
    },
    elements,
    enqueue: (...items) => responses.push(...items),
    location,
    requests
  };
}

test("startup asks the server for the first 50 records with no auth preflight", async () => {
  const record = sampleRecord();
  const harness = await createAppHarness([recordsResponse([record])]);

  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");
  assert.deepEqual(harness.requests.map(({ url }) => url), ["/api/uploads?limit=50"]);
  assert.equal(harness.elements.recordBody.children.length, 1);
  assert.match(harness.elements.recordBody.children[0].innerHTML, /已加载的记录/);
  assert.match(harness.elements.recordBody.children[0].innerHTML, /一份可检索的示例说明/);
});

test("failed refresh preserves rendered rows and the prior continuation cursor", async () => {
  const initialRecord = sampleRecord({ id: "initial-record", title: "Initial page" });
  const nextRecord = sampleRecord({ id: "next-record", title: "Next page" });
  const harness = await createAppHarness([
    recordsResponse([initialRecord], { nextCursor: "prior-continuation-cursor", hasMore: true }),
    jsonResponse(503, { error: "存储服务暂不可用" }),
    recordsResponse([nextRecord])
  ]);
  await waitFor(() => harness.elements.recordBody.children.length === 1);

  await harness.elements.refreshButton.dispatch("click");

  assert.equal(harness.elements.recordBody.children.length, 1);
  assert.match(harness.elements.recordBody.children[0].innerHTML, /Initial page/);
  assert.equal(harness.elements.toast.textContent, "存储服务暂不可用");
  assert.equal(harness.elements.loadMoreButton.hidden, false);
  assert.equal(harness.elements.loadMoreButton.disabled, false);

  await harness.elements.loadMoreButton.dispatch("click");
  await waitFor(() => harness.requests.length === 3);

  assert.equal(harness.requests[2].url, "/api/uploads?limit=50&cursor=prior-continuation-cursor");
  assert.equal(harness.elements.recordBody.children.length, 2);
  assert.match(harness.elements.recordBody.children[1].innerHTML, /Next page/);
});

test("first-load network failure shows retry state and retry recovers", async () => {
  const harness = await createAppHarness([new TypeError("Failed to fetch")]);
  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");

  assert.equal(harness.elements.recordsError.hidden, false);
  assert.equal(harness.elements.recordsLoading.hidden, true);
  assert.equal(harness.elements.recordsErrorMessage.textContent, "网络连接失败，请检查网络后重试");

  harness.enqueue(recordsResponse([sampleRecord({ title: "重试成功" })]));
  await harness.elements.retryButton.dispatch("click");
  await waitFor(() => harness.elements.recordBody.children.length === 1);

  assert.equal(harness.elements.recordsError.hidden, true);
  assert.equal(harness.elements.recordsLoading.hidden, true);
  assert.equal(harness.elements.recordsPanel.getAttribute("aria-busy"), "false");
  assert.match(harness.elements.recordBody.children[0].innerHTML, /重试成功/);
});

test("401 during startup redirects to login without an auth preflight", async () => {
  const harness = await createAppHarness([jsonResponse(401, { error: "登录已过期" })]);
  await waitFor(() => harness.location.href.startsWith("/login.html"));

  assert.equal(harness.location.href, "/login.html?next=%2F");
  assert.deepEqual(harness.requests.map(({ url }) => url), ["/api/uploads?limit=50"]);
});

test("first-load errors are announced and indefinite motion respects user preferences", async () => {
  const html = await readFile("public/index.html", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(html, /id="recordsError"[^>]*role="alert"/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /animation:\s*none/);
});

test("load more sends the current cursor and appends records deduplicated by id", async () => {
  const first = sampleRecord({ id: "first-record", title: "First page" });
  const duplicate = sampleRecord({ id: "first-record", title: "Duplicate from second page" });
  const second = sampleRecord({ id: "second-record", title: "Second page" });
  const harness = await createAppHarness([
    recordsResponse([first], { nextCursor: "opaque-next-cursor", hasMore: true }),
    recordsResponse([duplicate, second], { nextCursor: "second-opaque-cursor", hasMore: true }),
    recordsResponse([sampleRecord({ id: "third-record", title: "Third page" })])
  ]);
  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");

  assert.equal(harness.elements.recordBody.children.length, 1);
  assert.equal(harness.elements.loadMoreButton.hidden, false);

  await harness.elements.loadMoreButton.dispatch("click");
  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");

  assert.deepEqual(harness.requests.map(({ url }) => url), [
    "/api/uploads?limit=50",
    "/api/uploads?limit=50&cursor=opaque-next-cursor"
  ]);
  assert.equal(harness.elements.recordBody.children.length, 2);
  assert.equal(harness.elements.recordBody.children[0].dataset.id, "first-record");
  assert.match(harness.elements.recordBody.children[0].innerHTML, /Duplicate from second page/);
  assert.match(harness.elements.recordBody.children[1].innerHTML, /Second page/);
  assert.equal(harness.elements.loadMoreButton.disabled, false);

  await harness.elements.loadMoreButton.dispatch("click");
  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");

  assert.equal(harness.requests[2].url, "/api/uploads?limit=50&cursor=second-opaque-cursor");
  assert.equal(harness.elements.recordBody.children.length, 3);
  assert.equal(harness.elements.loadMoreButton.hidden, true);
});

test("search waits 200ms, sends q to the server, and resets to page one", async () => {
  const harness = await createAppHarness([
    recordsResponse([sampleRecord({ title: "Earlier page" })], {
      nextCursor: "obsolete-cursor",
      hasMore: true
    }),
    recordsResponse([sampleRecord({ title: "Deep target record" })])
  ]);
  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");

  harness.elements.searchInput.value = "Deep target";
  await harness.elements.searchInput.dispatch("input");
  assert.equal(harness.elements.recordBody.children.length, 1);

  harness.advanceTimersBy(199);
  assert.equal(harness.requests.length, 1);

  harness.advanceTimersBy(1);
  await waitFor(() => harness.elements.recordBody.children.length === 1
    && /Deep target record/.test(harness.elements.recordBody.children[0].innerHTML));

  assert.deepEqual(harness.requests.map(({ url }) => url), [
    "/api/uploads?limit=50",
    "/api/uploads?limit=50&q=Deep+target"
  ]);
  assert.equal(harness.elements.loadMoreButton.hidden, true);
});

test("type filters are sent to the server and refresh restarts at page one", async () => {
  const harness = await createAppHarness([
    recordsResponse([sampleRecord({ documentType: "Analysis", title: "All types" })], {
      nextCursor: "first-cursor",
      hasMore: true
    }),
    recordsResponse([sampleRecord({ documentType: "Analysis", title: "Filtered" })]),
    recordsResponse([sampleRecord({ documentType: "Analysis", title: "Refreshed" })])
  ]);
  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");

  harness.elements.typeFilter.value = "Analysis";
  await harness.elements.typeFilter.dispatch("change");
  await waitFor(() => harness.requests.length === 2);

  await harness.elements.refreshButton.dispatch("click");

  assert.deepEqual(harness.requests.map(({ url }) => url), [
    "/api/uploads?limit=50",
    "/api/uploads?limit=50&documentType=Analysis",
    "/api/uploads?limit=50&documentType=Analysis"
  ]);
  assert.match(harness.elements.recordBody.children[0].innerHTML, /Refreshed/);
});

test("a late response from an abandoned search cannot replace a newer query", async () => {
  const delayedSearch = deferred();
  const harness = await createAppHarness([
    recordsResponse([sampleRecord({ title: "Initial" })]),
    delayedSearch.promise,
    recordsResponse([sampleRecord({ title: "New query" })])
  ]);
  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");

  harness.elements.searchInput.value = "Old query";
  await harness.elements.searchInput.dispatch("input");
  harness.advanceTimersBy(200);
  await waitFor(() => harness.requests.length === 2);

  harness.elements.searchInput.value = "New query";
  await harness.elements.searchInput.dispatch("input");
  harness.advanceTimersBy(200);
  await waitFor(() => /New query/.test(harness.elements.recordBody.children[0].innerHTML));

  delayedSearch.resolve(recordsResponse([sampleRecord({ title: "Old query" })]));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(harness.elements.recordBody.children[0].innerHTML, /New query/);
});

test("records view includes a hidden load-more control", async () => {
  const html = await readFile("public/index.html", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(html, /id="loadMoreButton"[^>]*hidden/);
  assert.match(css, /\.records-pagination/);
});

test("upload uses browser byte progress before the processing state", async () => {
  const appSource = await readFile("public/app.js", "utf8");

  assert.match(appSource, /XMLHttpRequest/);
  assert.match(appSource, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(appSource, /setUploadPhase\("processing"\)/);
});

test("the page includes accessible upload progress and records skeletons", async () => {
  const indexSource = await readFile("public/index.html", "utf8");

  assert.match(indexSource, /role="progressbar"/);
  assert.match(indexSource, /aria-valuenow/);
  assert.match(indexSource, /records-skeleton/);
});

test("motion is disabled for reduced-motion users", async () => {
  const stylesSource = await readFile("public/styles.css", "utf8");

  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(stylesSource, /animation:\s*none/);
});

test("appended and newly published records receive state-driven motion hooks", async () => {
  const appSource = await readFile("public/app.js", "utf8");

  assert.match(appSource, /row\.dataset\.entering = "true"/);
  assert.match(appSource, /record-row--success/);
  assert.match(appSource, /addEventListener\("animationend"/);
});
