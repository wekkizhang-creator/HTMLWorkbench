const NODE_KEY = 'data-hwb-editor-node-key';
const activeDocuments = new WeakSet();
let sequence = 0;

function declaredDimension(element, property, view) {
  const typed = element.computedStyleMap?.().get(property);
  if (typed) return String(typed);
  let value = element.style.getPropertyValue(property);
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.selectorText && rule.style?.getPropertyValue(property)) {
        try { if (element.matches(rule.selectorText)) value ||= rule.style.getPropertyValue(property); } catch {}
      }
      if (rule.cssRules) visit(rule.cssRules);
    }
  };
  for (const sheet of element.ownerDocument.styleSheets) {
    try { visit(sheet.cssRules); } catch { return view.getComputedStyle(element)[property]; }
  }
  return value || 'auto';
}

function dimension(stage, slides, property, fallback, view) {
  for (const element of [stage, ...slides]) {
    const declared = declaredDimension(element, property, view);
    if (declared === 'auto' || declared === 'none' || !declared) continue;
    if (/%|\b(?:vw|vh|vmin|vmax|dvw|dvh)\b/.test(declared)) return null;
    const value = Number.parseFloat(view.getComputedStyle(element)[property]);
    return Number.isFinite(value) && value >= 100 && value <= 16384 ? value : null;
  }
  return fallback;
}

/** Uploaded scripts must already be paused by the owning iframe sandbox. */
export function createPresentation(doc) {
  const view = doc?.defaultView;
  if (!view || !doc.body || activeDocuments.has(doc)) return null;
  const candidates = [...doc.querySelectorAll('.stage')].map(stage => ({
    stage, slides: [...stage.children].filter(node => node.matches('.slide'))
  })).filter(item => item.slides.length >= 2);
  if (candidates.length !== 1) return null;
  const { stage, slides } = candidates[0];
  if (slides.some(slide => slide.querySelector('.slide')) || !doc.body.contains(stage)) return null;
  const width = dimension(stage, slides, 'width', 1440, view);
  const height = dimension(stage, slides, 'height', 810, view);
  if (!width || !height || width / height < 0.1 || width / height > 10) return null;

  let marker;
  do { marker = `data-hwb-presentation-${++sequence}`; } while (doc.querySelector(`[${marker}]`));
  const records = [];
  const keyCounts = new Map();
  for (const node of doc.querySelectorAll(`[${NODE_KEY}]`)) {
    const key = node.getAttribute(NODE_KEY);
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  function mark(node, value) {
    const originals = new Map();
    const change = (name, next) => {
      originals.set(name, node.getAttribute(name));
      if (next === null) node.removeAttribute(name); else node.setAttribute(name, next);
    };
    let key = node.getAttribute(NODE_KEY);
    if (!key || keyCounts.get(key) !== 1) {
      do { key = `${marker}-node-${++sequence}`; } while (keyCounts.has(key));
      keyCounts.set(key, 1);
      change(NODE_KEY, key);
    }
    change(marker, value);
    change('hidden', null);
    change('aria-hidden', null);
    records.push({ node, key, originals });
  }
  const route = [];
  for (let node = stage; node; node = node.parentElement) route.push(node);
  for (const node of route) mark(node, 'path');
  const displays = slides.map(slide => {
    const display = view.getComputedStyle(slide).display;
    return display === 'none' ? 'block' : display;
  });
  slides.forEach((slide, i) => mark(slide, `slide-${i}`));
  const style = doc.createElement('style');
  style.setAttribute(marker, 'override');
  doc.head.append(style);
  activeDocuments.add(doc);

  const notesNodes = doc.querySelectorAll('script#notes-data');
  const notesNode = notesNodes.length === 1 ? notesNodes[0] : null;
  let notesAvailable = false;
  const readNotes = () => {
    try {
      const value = JSON.parse(notesNode?.textContent ?? '');
      return Array.isArray(value) && value.length === slides.length && value.every(note => typeof note === 'string') ? value : null;
    } catch { return null; }
  };
  notesAvailable = Boolean(readNotes());
  let index = 0;
  let disposed = false;
  const validateIndex = (value) => {
    if (!Number.isInteger(value) || value < 0 || value >= slides.length) throw new RangeError('Invalid presentation slide index');
  };
  const css = (chosen) => {
    const path = `[${marker}="path"]`;
    const slide = `[${marker}^="slide-"]`;
    const selected = `[${marker}="slide-${chosen}"]`;
    return `
${path} > :not(${path}):not(${slide}):not(head) { display: none !important; }
${path}::before, ${path}::after { display: none !important; }
${path} { display: block !important; position: relative !important; width: ${width}px !important; height: ${height}px !important; min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important; box-sizing: border-box !important; transform: none !important; translate: none !important; rotate: none !important; scale: none !important; zoom: 1 !important; overflow: hidden !important; opacity: 1 !important; visibility: visible !important; content-visibility: visible !important; animation: none !important; transition: none !important; }
${slide} { display: none !important; }
${selected} { display: ${displays[chosen]} !important; position: absolute !important; inset: 0 !important; width: ${width}px !important; height: ${height}px !important; min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important; margin: 0 !important; box-sizing: border-box !important; transform: none !important; translate: none !important; rotate: none !important; scale: none !important; opacity: 1 !important; visibility: visible !important; content-visibility: visible !important; animation: none !important; transition: none !important; }
`;
  };
  function restore(node, originals) {
    for (const [name, value] of originals) {
      if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
    }
  }
  const adapter = {
    slides, width, height,
    get index() { return index; },
    notesAvailable,
    activate(value) {
      validateIndex(value);
      if (disposed) return;
      index = value;
      style.textContent = css(index);
      slides.forEach((slide, i) => {
        slide.toggleAttribute('hidden', i !== index);
        slide.setAttribute('aria-hidden', String(i !== index));
      });
    },
    restoreClone(clone) {
      const byKey = new Map([...clone.querySelectorAll(`[${NODE_KEY}]`)].map(node => [node.getAttribute(NODE_KEY), node]));
      clone.querySelectorAll(`style[${marker}="override"]`).forEach(node => node.remove());
      for (const record of records) {
        const node = byKey.get(record.key);
        if (node) restore(node, record.originals);
      }
    },
    getNotes(value) {
      validateIndex(value);
      return notesAvailable ? (readNotes()?.[value] ?? '') : '';
    },
    setNotes(value, text) {
      validateIndex(value);
      if (!notesAvailable || disposed) return;
      if (typeof text !== 'string') throw new TypeError('Notes must be a string');
      const notes = readNotes();
      if (!notes) return;
      notes[value] = text;
      notesNode.textContent = JSON.stringify(notes).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    },
    thumbnailHtml(value) {
      validateIndex(value);
      if (disposed) throw new Error('Presentation adapter is disposed');
      const clone = doc.cloneNode(true);
      clone.querySelectorAll(`[${marker}^="slide-"]`).forEach(node => {
        if (node.getAttribute(marker) !== `slide-${value}`) node.remove();
        else { node.removeAttribute('hidden'); node.setAttribute('aria-hidden', 'false'); }
      });
      clone.querySelector(`style[${marker}="override"]`).textContent = css(value);
      clone.querySelectorAll('script,iframe,object,embed,meta[http-equiv]').forEach(node => {
        if (node.tagName !== 'META' || node.getAttribute('http-equiv').trim().toLowerCase() === 'refresh') node.remove();
      });
      return '<!DOCTYPE html>\n' + clone.documentElement.outerHTML;
    },
    dispose() {
      if (disposed) return;
      style.remove();
      for (const { node, originals } of records) restore(node, originals);
      activeDocuments.delete(doc);
      disposed = true;
    }
  };
  // Verify the cascade rather than mutating author inline !important declarations.
  const surrounding = route.flatMap(node => [...node.children]).filter(node =>
    !route.includes(node) && !slides.includes(node) && node.tagName !== 'HEAD');
  for (let i = 0; i < slides.length; i += 1) {
    adapter.activate(i);
    const rect = slides[i].getBoundingClientRect();
    const computed = view.getComputedStyle(slides[i]);
    const invalid = Math.abs(rect.x) > 0.5 || Math.abs(rect.y) > 0.5 ||
      Math.abs(rect.width - width) > 0.5 || Math.abs(rect.height - height) > 0.5 ||
      computed.display === 'none' || computed.visibility !== 'visible' || Number(computed.opacity) !== 1 ||
      surrounding.some(node => view.getComputedStyle(node).display !== 'none') ||
      slides.some((node, other) => other !== i && view.getComputedStyle(node).display !== 'none');
    if (invalid) { adapter.dispose(); return null; }
  }
  adapter.activate(0);
  return adapter;
}
