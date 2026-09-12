import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

test('presentation browser contract', { skip: !process.env.EDITOR_PLAYWRIGHT_MODULE }, async (t) => {
  const { chromium } = createRequire(import.meta.url)(process.env.EDITOR_PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let source;
  try { source = await readFile(new URL('../public/editor-presentation.mjs', import.meta.url), 'utf8'); } catch {}
  assert.ok(source, 'presentation adapter exists');
  await page.goto('about:blank');
  await page.addScriptTag({ type: 'module', content: `${source}\nwindow.createPresentation = createPresentation;` });
  await page.waitForFunction(() => window.createPresentation);
  const core = await readFile(new URL('../public/editor-core.mjs', import.meta.url), 'utf8');
  await page.addScriptTag({ type: 'module', content: `${core}\nwindow.assignEditorNodeIds = assignEditorNodeIds; window.scrubEditorArtifacts = scrubEditorArtifacts;` });
  await page.waitForFunction(() => window.assignEditorNodeIds);
  const fixture = `<html><head><base href="https://example.com/"><style>
    body { margin: 30px; } main { transform: scale(.6); padding: 25px; }
    .stage { width: 1200px; height: 700px; position: relative; }
    .slide { display: none; position: absolute; width: 100%; height: 100%; opacity: 0; }
    .slide.active { display: grid; opacity: 1; }
    </style></head><body><nav>Toolbar</nav><main style="color: red"><div class="stage">
    <section class="slide active" hidden="until-found" aria-hidden="false" data-hwb-editor-node-key="author"><h1>One</h1></section>
    <section class="slide" aria-hidden="true"><h1>Two</h1></section><button>Next</button>
    </div><footer>Footer</footer></main><script id="notes-data" type="application/json">["a","b"]</script>
    <script>window.uploadedRan = true</script><iframe src="about:blank"></iframe><object></object><embed><meta http-equiv="refresh" content="999999"></body></html>`;
  await page.evaluate((html) => {
    window.makeDoc = (value) => {
      const parsed = new DOMParser().parseFromString(value, 'text/html');
      document.head.innerHTML = parsed.head.innerHTML;
      document.body.innerHTML = parsed.body.innerHTML;
      return document;
    };
    window.fixture = html;
  }, fixture);
  await t.test('detects conservatively and falls back only without dimensions', async () => {
    const result = await page.evaluate(() => {
      const check = (html) => { const a = createPresentation(makeDoc(html)); const r = a ? [a.width, a.height] : null; a?.dispose(); return r; };
      return [check('<div class="stage"><div class="slide"></div></div>'),
        check('<div class="stage"><div class="slide"></div><div class="slide"></div></div>'),
        check('<style>.stage{width:0px;height:700px}</style><div class="stage"><div class="slide"></div><div class="slide"></div></div>'),
        check('<style>.stage{width:999999px;height:700px}</style><div class="stage"><div class="slide"></div><div class="slide"></div></div>'),
        check('<div class="stage"><div class="slide"></div><div class="slide"></div></div>'.repeat(2))];
    });
    assert.deepEqual(result, [null, [1440,810], null, null, null]);
  });
  await t.test('activates original nodes, hides surrounding UI and preserves edited clone styles', async () => {
    const result = await page.evaluate(() => {
      makeDoc(fixture);
      const before = document.documentElement.outerHTML;
      const nodes = [...document.querySelectorAll('.slide')];
      const a = createPresentation(document);
      a.activate(1);
      const rect = nodes[1].getBoundingClientRect();
      const visible = [document.querySelector('nav'), nodes[0], document.querySelector('button'), document.querySelector('footer')].map(n => getComputedStyle(n).display);
      nodes[1].style.backgroundColor = 'blue';
      document.querySelector('main').style.color = 'green';
      const clone = document.cloneNode(true);
      a.restoreClone(clone);
      const expected = new DOMParser().parseFromString(before, 'text/html');
      expected.querySelectorAll('.slide')[1].style.backgroundColor = 'blue';
      expected.querySelector('main').style.color = 'green';
      const restored = clone.documentElement.isEqualNode(expected.documentElement);
      const stable = a.slides.every((n,i) => n === nodes[i]);
      const size = [a.width,a.height,rect.x,rect.y,rect.width,rect.height];
      a.dispose();
      return { visible, restored, stable, size, disposed: document.documentElement.isEqualNode(expected.documentElement) };
    });
    assert.deepEqual(result, { visible: ['none','none','none','none'], restored: true, stable: true, size: [1200,700,0,0,1200,700], disposed: true });
  });
  await t.test('hidden page two retains flex/grid layout and footer inside the canvas', async () => {
    for (const layout of ['flex', 'grid']) {
      const result = await page.evaluate((layout) => {
        makeDoc(`<style>
          .stage { width: 1440px; height: 810px; }
          .slide { display: ${layout}; flex-direction: column; grid-template-rows: 60px minmax(0,1fr) 40px; padding: 40px; }
          .slide[hidden], .slide[aria-hidden="true"] { display: none !important; }
          header { height: 60px; flex: 0 0 60px; }
          .content { height: 100%; min-height: 0; flex: 1 1 auto; }
          footer { height: 40px; flex: 0 0 40px; }
          </style><div class="stage"><section class="slide">One</section>
          <section class="slide" hidden="until-found" aria-hidden="true"><header>Two</header><div class="content">Body</div><footer>Page 2 footer</footer></section></div>`);
        const original = document.cloneNode(true);
        const a = createPresentation(document);
        try {
          a.activate(1);
          const slide = a.slides[1];
          const footer = slide.querySelector('footer').getBoundingClientRect();
          const clone = document.cloneNode(true); a.restoreClone(clone);
          return { display: getComputedStyle(slide).display, inside: footer.top >= 0 && footer.bottom <= a.height,
            restored: clone.documentElement.isEqualNode(original.documentElement), html: a.thumbnailHtml(1) };
        } finally { a?.dispose(); }
      }, layout);
      assert.equal(result.display, layout);
      assert.equal(result.inside, true, `${layout} footer must fit the logical canvas`);
      assert.equal(result.restored, true);
      const preview = await browser.newPage();
      try {
        await preview.setContent(result.html);
        assert.deepEqual(await preview.evaluate(() => [getComputedStyle(document.querySelector('.slide')).display,
          document.querySelector('footer').getBoundingClientRect().bottom <= 810]), [layout, true]);
      } finally { await preview.close(); }
    }
  });
  await t.test('notes slot updates are safe, persisted, and invalid data stays untouched', async () => {
    const result = await page.evaluate(() => {
      makeDoc(fixture);
      const a = createPresentation(document);
      const value = '</script><script>alert(1)</script>\u2028&';
      a.setNotes(1,value);
      const text = document.querySelector('#notes-data').textContent;
      const clone = document.cloneNode(true); a.restoreClone(clone);
      const good = a.notesAvailable && a.getNotes(0) === 'a' && a.getNotes(1) === value && !text.includes('<') && JSON.parse(clone.querySelector('#notes-data').textContent)[1] === value;
      let range = false; try { a.activate(2); } catch(e) { range = e instanceof RangeError; }
      a.dispose();
      document.querySelector('#notes-data').textContent = '["only one"]';
      const b = createPresentation(document);
      const disabled = !b.notesAvailable; b.setNotes(0,'changed'); b.dispose();
      return {good,range,disabled,text:document.querySelector('#notes-data').textContent};
    });
    assert.deepEqual(result,{good:true,range:true,disabled:true,text:'["only one"]'});
  });
  await t.test('thumbnail is inert, isolated and retains styles/base', async () => {
    const result = await page.evaluate(() => {
      makeDoc(fixture);
      const a = createPresentation(document); a.activate(0);
      const before = document.documentElement.outerHTML;
      const html = a.thumbnailHtml(1);
      const clone = new DOMParser().parseFromString(html,'text/html');
      const result = { unchanged: before === document.documentElement.outerHTML && a.index === 0,
        slides: clone.querySelectorAll('.slide').length, text: clone.querySelector('.slide').textContent,
        unsafe: clone.querySelectorAll('script,iframe,object,embed,meta[http-equiv="refresh"]').length,
        base: clone.querySelector('base').getAttribute('href'), styles: clone.querySelectorAll('style').length };
      a.dispose(); return result;
    });
    assert.deepEqual(result,{unchanged:true,slides:1,text:'Two',unsafe:0,base:'https://example.com/',styles:2});
  });
  await t.test('core cleanup restores colliding author keys and temporary attribute names', async () => {
    assert.equal(await page.evaluate(() => {
      makeDoc(fixture);
      document.body.setAttribute('data-hwb-presentation-1','author-value');
      document.querySelectorAll('.slide')[1].setAttribute('data-hwb-editor-node-key','author');
      const original = document.cloneNode(true);
      assignEditorNodeIds(document);
      const keys = [...document.querySelectorAll('[data-hwb-editor-node-key]')].map(n => n.getAttribute('data-hwb-editor-node-key'));
      const a = createPresentation(document); a.activate(1);
      const sameKeys = keys.every((key,i) => key === document.querySelectorAll('[data-hwb-editor-node-key]')[i].getAttribute('data-hwb-editor-node-key'));
      const clone = document.cloneNode(true); a.restoreClone(clone); scrubEditorArtifacts(clone); a.dispose();
      return sameKeys && original.documentElement.isEqualNode(clone.documentElement);
    }), true);
  });
  await t.test('unoverridable author important layout is rejected without mutation', async () => {
    assert.equal(await page.evaluate(() => {
      makeDoc(fixture);
      document.querySelector('.slide').style.setProperty('display','none','important');
      const before = document.cloneNode(true);
      const a = createPresentation(document);
      const rejected = a === null; a?.dispose();
      return rejected && before.documentElement.isEqualNode(document.documentElement);
    }),true);
  });
  await t.test('thumbnail logical canvas stays fixed at a mobile viewport', async () => {
    const html = await page.evaluate(() => {
      makeDoc(fixture); const a = createPresentation(document); const html = a.thumbnailHtml(1); a.dispose(); return html;
    });
    const preview = await browser.newPage({viewport:{width:390,height:844}});
    try {
      await preview.setContent(html);
      assert.deepEqual(await preview.evaluate(() => {
        const r = document.querySelector('.slide').getBoundingClientRect();
        return [r.x,r.y,r.width,r.height, getComputedStyle(document.querySelector('nav')).display, Boolean(window.uploadedRan)];
      }),[0,0,1200,700,'none',false]);
    } finally { await preview.close(); }
  });
});
