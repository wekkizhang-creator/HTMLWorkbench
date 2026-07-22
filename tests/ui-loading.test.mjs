import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const ELEMENT_IDS = [
  "clearButton", "copyLatestButton", "documentTypeCustom", "documentTypeSelect",
  "dropzone", "emptyState", "emptyText", "fileDetail", "fileInput", "fileName",
  "latestLink", "latestTime", "linkStatus", "logoutButton", "openLatestButton",
  "originText", "recordBody", "recordsError", "recordsErrorMessage", "recordsLoading",
  "recordsPanel", "refreshButton", "retryButton", "searchInput", "titleInput", "toast",
  "totalCount", "typeFilter", "uploadButton", "uploadButtonLabel", "uploadForm",
  "uploadStatus"
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
    clearTimeout() {},
    confirm: () => true,
    isSecureContext: true,
    location,
    prompt: () => "",
    removeEventListener() {},
    setTimeout: () => 1
  };
  const context = {
    FormData,
    Intl,
    URL,
    document,
    fetch,
    navigator: {},
    window
  };

  vm.runInNewContext(source, context, { filename: "public/app.js" });
  return {
    elements,
    enqueue: (...items) => responses.push(...items),
    location,
    requests
  };
}

test("startup loads seeded records with one uploads request and no auth preflight", async () => {
  const record = sampleRecord();
  const harness = await createAppHarness([jsonResponse(200, { records: [record] })]);

  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");
  assert.deepEqual(harness.requests.map(({ url }) => url), ["/api/uploads"]);
  assert.equal(harness.elements.recordBody.children.length, 1);
  assert.match(harness.elements.recordBody.children[0].innerHTML, /已加载的记录/);
  assert.match(harness.elements.recordBody.children[0].innerHTML, /一份可检索的示例说明/);
});

test("failed refresh preserves rendered records and actionable backend text", async () => {
  const harness = await createAppHarness([
    jsonResponse(200, { records: [sampleRecord()] }),
    jsonResponse(503, { error: "存储服务暂不可用" })
  ]);
  await waitFor(() => harness.elements.recordBody.children.length === 1);

  await harness.elements.refreshButton.dispatch("click");

  assert.equal(harness.elements.recordBody.children.length, 1);
  assert.match(harness.elements.recordBody.children[0].innerHTML, /已加载的记录/);
  assert.equal(harness.elements.toast.textContent, "存储服务暂不可用");
});

test("first-load network failure shows localized retry state and retry recovers", async () => {
  const harness = await createAppHarness([new TypeError("Failed to fetch")]);
  await waitFor(() => harness.elements.recordsPanel.getAttribute("aria-busy") === "false");

  assert.equal(harness.elements.recordsError.hidden, false);
  assert.equal(harness.elements.recordsLoading.hidden, true);
  assert.equal(harness.elements.recordsErrorMessage.textContent, "网络连接失败，请检查网络后重试");

  harness.enqueue(jsonResponse(200, { records: [sampleRecord({ title: "重试成功" })] }));
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
  assert.deepEqual(harness.requests.map(({ url }) => url), ["/api/uploads"]);
});

test("first-load errors are announced and indefinite motion respects user preferences", async () => {
  const html = await readFile("public/index.html", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(html, /id="recordsError"[^>]*role="alert"/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /animation:\s*none/);
});
