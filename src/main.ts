import './style.css';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { exportPdf, type El } from './export';
import { drawSignature, type Sig } from './signature';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// An empty form widget in display points: a click / Tab / signature target.
type Field = { kind: 'text' | 'comb' | 'check'; x: number; y: number; w: number; h: number; maxLen: number; multiline: boolean };

type Page = {
  viewport1: PageViewport;
  fields: Field[]; // sorted in reading order
  el: HTMLDivElement;
  layer: HTMLDivElement; // clips fields + elements to the page, like the PDF does
  canvas: HTMLCanvasElement;
  scale: number;
  job: number; // id of the render in progress, 0 = none
  done: boolean; // canvas is up to date
  task: RenderTask | null;
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const emptyEl = $('#empty');
const editorEl = $('#editor');
const pagesEl = $('#pages');
const hintEl = $('#hint');
const nameEl = $('#name');
const fileInput = $<HTMLInputElement>('#file');
const downloadBtn = $<HTMLButtonElement>('#download');

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
const SIG_KEY = 'pdffiller.signature';

let pdf: PDFDocumentProxy | null = null;
let loadingTask: PDFDocumentLoadingTask | null = null;
let loadGen = 0;
let bytes: Uint8Array | null = null;
let password = '';
let baseName = '';
let pages: Page[] = [];
let hasFields = false;
let els: El[] = [];
let cleanState = '[]'; // snapshot of els at open / last download
const nodes = new Map<string, HTMLElement>();
let selected: string | null = null;
let mode: 'none' | 'check' | 'sig' = 'none';
let sig: Sig | null = null;
let nextId = 1;
let jobSeq = 0;
let lastWidth = 0;

const toolbar = document.createElement('div');
toolbar.className = 'toolbar';
toolbar.innerHTML = `<button data-a="-">−</button><button data-a="+">+</button><button data-a="del">🗑</button>`;

const cssWidth = () => Math.min(window.innerWidth - 48, 850);
const editing = () => (document.activeElement as HTMLElement | null)?.isContentEditable ?? false;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const typed = (e: El) => e.type === 'text' || e.type === 'comb';
const inside = (f: Field, x: number, y: number) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h;

// ---------- Loading ----------

function openFile(file: File) {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return alert('Please choose a PDF file.');
  if (JSON.stringify(els) !== cleanState && !confirm('Replace the current document? Your edits will be lost.')) return;
  load(file);
}

async function readPage(page: PDFPageProxy) {
  const viewport1 = page.getViewport({ scale: 1 });
  const fields: Field[] = [];
  for (const a of await page.getAnnotations()) {
    if (a.subtype !== 'Widget' || !['Tx', 'Ch', 'Btn'].includes(a.fieldType) || a.hidden || a.noView || a.pushButton) continue;
    // Read-only is ignored (XFA logic sets it on ordinary blanks), except read-only multiline = barcode.
    if (a.readOnly && a.multiLine) continue;
    // Values baked into the PDF are not ours to edit: pre-filled widgets are not targets.
    const v = a.fieldValue;
    if (a.fieldType === 'Btn' ? v === a.exportValue || (v && v !== 'Off') : String(v ?? '').trim()) continue;
    const [x1, y1] = viewport1.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = viewport1.convertToViewportPoint(a.rect[2], a.rect[3]);
    const f: Field = {
      kind: a.fieldType === 'Btn' ? 'check' : a.comb && a.maxLen > 0 ? 'comb' : 'text',
      x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
      maxLen: a.maxLen || 0, multiline: !!a.multiLine,
    };
    if (f.w > 0 && f.h > 0) fields.push(f);
  }
  fields.sort((a, b) => Math.round(a.y / 4) - Math.round(b.y / 4) || a.x - b.x);
  return { viewport1, fields };
}

async function load(file: File) {
  const gen = ++loadGen;
  const data = new Uint8Array(await file.arrayBuffer());
  let pw = '';
  let task: PDFDocumentLoadingTask;
  let info: Awaited<ReturnType<typeof readPage>>[];
  for (;;) {
    // pdf.js transfers the buffer it is given, so hand it a copy and keep the original for pdf-lib.
    task = pdfjs.getDocument({
      data: data.slice(),
      password: pw,
      standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    try {
      const doc = await task.promise;
      info = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1).then(readPage)));
      break;
    } catch (err) {
      task.destroy();
      if (gen !== loadGen) return;
      if ((err as Error)?.name !== 'PasswordException') return alert("Couldn't open that file. Is it a valid PDF?");
      const entered = prompt(pw ? 'Wrong password. Try again:' : 'This PDF needs a password');
      if (entered === null) return; // cancelled: keep the current document
      pw = entered;
    }
  }
  if (gen !== loadGen) return void task.destroy();
  loadingTask?.destroy();
  loadingTask = task;
  pdf = await task.promise;
  bytes = data;
  password = pw;
  baseName = file.name.replace(/\.pdf$/i, '');
  els = [];
  cleanState = '[]';
  nodes.clear();
  selected = null;
  toolbar.remove();
  observer.disconnect();
  pages.forEach(reset);
  pagesEl.textContent = '';
  pages = info.map(({ viewport1, fields }, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.index = String(i);
    const canvas = document.createElement('canvas');
    const layer = document.createElement('div');
    layer.className = 'layer';
    for (const f of fields) {
      const d = document.createElement('div');
      d.className = `field ${f.kind === 'check' ? 'check' : 'text'}`;
      layer.append(d);
    }
    el.append(canvas, layer);
    pagesEl.append(el);
    return { viewport1, fields, el, layer, canvas, scale: 1, job: 0, done: false, task: null };
  });
  hasFields = pages.some((p) => p.fields.length > 0);
  setMode('none');
  nameEl.textContent = file.name;
  emptyEl.hidden = true;
  editorEl.hidden = false;
  window.scrollTo(0, 0);
  layout();
}

// ---------- Rendering ----------

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const i = Number((entry.target as HTMLElement).dataset.index);
      const p = pages[i];
      if (p?.el !== entry.target) continue;
      if (entry.isIntersecting) render(p, i);
      else {
        reset(p);
        p.canvas.width = p.canvas.height = 0; // free memory for far-away pages
      }
    }
  },
  { rootMargin: '1000px 0px' },
);

function layout() {
  const w = cssWidth();
  lastWidth = window.innerWidth;
  for (const p of pages) {
    reset(p);
    const s = (p.scale = w / p.viewport1.width);
    p.el.style.width = `${w}px`;
    p.el.style.height = `${p.viewport1.height * s}px`;
    const boxes = p.layer.querySelectorAll<HTMLElement>('.field');
    p.fields.forEach((f, i) => {
      Object.assign(boxes[i].style, { left: `${f.x * s}px`, top: `${f.y * s}px`, width: `${f.w * s}px`, height: `${f.h * s}px` });
    });
    observer.unobserve(p.el);
    observer.observe(p.el); // fires again, re-rendering visible pages
  }
  els.forEach(position);
  placeToolbar();
}

function reset(p: Page) {
  p.task?.cancel();
  p.task = null;
  p.job = 0;
  p.done = false;
}

async function render(p: Page, i: number) {
  if (!pdf || p.job || p.done) return;
  const job = (p.job = ++jobSeq);
  const page = await pdf.getPage(i + 1).catch(() => null);
  if (!page || p.job !== job) return;
  const viewport = page.getViewport({ scale: p.scale * (window.devicePixelRatio || 1) });
  p.canvas.width = Math.floor(viewport.width);
  p.canvas.height = Math.floor(viewport.height);
  p.task = page.render({ canvas: p.canvas, viewport });
  try {
    await p.task.promise;
    if (p.job === job) p.done = true;
  } catch {
    // cancelled (resize / scrolled away)
  }
  if (p.job === job) (p.job = 0), (p.task = null);
}

// ---------- Elements ----------

function position(e: El) {
  const n = nodes.get(e.id)!;
  const s = pages[e.pageIndex].scale;
  const px = (v: number) => `${v * s}px`;
  Object.assign(n.style, { left: px(e.x), top: px(e.y) });
  if (e.w) n.style.width = px(e.w);
  if (e.type === 'sig') n.style.height = px(e.h!);
  else n.style.fontSize = px(e.fontSize!);
  if (e.type === 'comb') {
    const fs = e.fontSize!;
    const cell = e.w! / e.maxLen!;
    Object.assign(n.style, { height: px(e.h!), paddingTop: px((e.h! - 1.2 * fs) / 2), paddingLeft: px((cell - 0.6 * fs) / 2), letterSpacing: px(cell - 0.6 * fs) });
  }
}

function add(e: El) {
  els.push(e);
  let n: HTMLElement;
  if (e.type === 'sig') {
    const img = new Image();
    img.src = e.dataUrl!;
    img.draggable = false;
    n = img;
  } else {
    n = document.createElement('div');
    n.textContent = e.type === 'check' ? '✓' : (e.text ?? '');
  }
  n.className = `el ${e.type}${e.type === 'text' && e.w ? ' wrap' : ''}${e.type === 'check' && e.field !== undefined ? ' form' : ''}`;
  nodes.set(e.id, n);
  pages[e.pageIndex].layer.append(n);
  position(e);
  n.addEventListener('pointerdown', (ev) => onElementDown(ev, e, n));
  if (!typed(e)) return;

  n.addEventListener('input', () => {
    const raw = n.innerText.replace(/\n$/, '');
    let t = raw;
    if (e.type === 'comb') t = t.replace(/\n/g, '');
    else if (e.field !== undefined && !e.w) t = t.replace(/\n/g, ' '); // single-line field
    if (e.maxLen) t = t.slice(0, e.maxLen);
    if (t !== raw) {
      n.textContent = t;
      caretToEnd(n);
    }
    e.text = t;
    placeToolbar();
  });
  n.addEventListener('keydown', (ev) => {
    if (ev.key === 'Backspace' && !e.text) {
      ev.preventDefault();
      remove(e.id);
    } else if (ev.key === 'Enter' && e.field !== undefined && !e.w) ev.preventDefault(); // single-line field
    else if (ev.key === 'Tab') {
      ev.preventDefault();
      if (e.field !== undefined) tabFrom(e.pageIndex, e.field, ev.shiftKey ? -1 : 1);
      else n.blur(), select(null); // free box: commit and leave
    }
  });
  n.addEventListener('blur', () => {
    n.contentEditable = 'false';
    if (els.includes(e) && !e.text?.trim()) remove(e.id);
  });
  edit(e, n);
}

function caretToEnd(n: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(n);
  range.collapse(false);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
}

function edit(e: El, n: HTMLElement) {
  n.contentEditable = 'plaintext-only';
  n.focus();
  caretToEnd(n);
  select(e.id);
}

function remove(id: string) {
  els = els.filter((e) => e.id !== id);
  nodes.get(id)?.remove();
  nodes.delete(id);
  if (selected === id) select(null);
}

function select(id: string | null) {
  if (selected) nodes.get(selected)?.classList.remove('sel');
  selected = id;
  if (id) nodes.get(id)?.classList.add('sel');
  placeToolbar();
}

function placeToolbar() {
  const e = els.find((e) => e.id === selected);
  if (!e) return toolbar.remove();
  const n = nodes.get(e.id)!;
  const page = pages[e.pageIndex].el;
  page.append(toolbar);
  const top = n.offsetTop - 36;
  toolbar.style.top = `${top < 0 ? n.offsetTop + n.offsetHeight + 6 : top}px`;
  toolbar.style.left = `${clamp(n.offsetLeft, 0, page.clientWidth - toolbar.offsetWidth)}px`;
}

function onElementDown(ev: PointerEvent, e: El, n: HTMLElement) {
  if (mode !== 'none' || document.activeElement === n) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (editing()) (document.activeElement as HTMLElement).blur();
  const p = pages[e.pageIndex];
  const sx = ev.clientX, sy = ev.clientY, ox = e.x, oy = e.y;
  let moved = false;
  n.setPointerCapture(ev.pointerId);
  const move = (m: PointerEvent) => {
    const dx = m.clientX - sx, dy = m.clientY - sy;
    if (!moved && Math.hypot(dx, dy) <= 4) return;
    moved = true;
    e.x = clamp(ox + dx / p.scale, 0, p.viewport1.width - 8);
    e.y = clamp(oy + dy / p.scale, 0, p.viewport1.height - 8);
    position(e);
    placeToolbar();
  };
  const up = () => {
    n.removeEventListener('pointermove', move);
    n.removeEventListener('pointerup', up);
    n.removeEventListener('pointercancel', up);
    // Dragged out of its field (center outside): becomes a free element; the field is clickable again.
    const f = e.field === undefined ? null : p.fields[e.field];
    if (moved && f && !inside(f, e.x + n.offsetWidth / 2 / p.scale, e.y + n.offsetHeight / 2 / p.scale)) {
      delete e.field;
      if (e.type === 'text') delete e.maxLen;
      n.classList.remove('form');
    }
    if (typed(e)) edit(e, n);
    else if (!moved && e.field !== undefined) remove(e.id); // tapping a form check mark unchecks it
    else select(e.id);
  };
  n.addEventListener('pointermove', move);
  n.addEventListener('pointerup', up);
  n.addEventListener('pointercancel', up);
}

function scaleSelected(dir: 1 | -1) {
  const e = els.find((e) => e.id === selected);
  if (!e) return;
  if (e.type === 'sig') {
    const f = dir > 0 ? 1.1 : 1 / 1.1;
    e.w! *= f;
    e.h! *= f;
  } else {
    const fs = e.fontSize!;
    e.fontSize = dir > 0 ? (SIZES.find((s) => s > fs) ?? fs) : (SIZES.findLast((s) => s < fs) ?? fs);
  }
  position(e);
  placeToolbar();
}

toolbar.addEventListener('pointerdown', (ev) => (ev.preventDefault(), ev.stopPropagation()));
toolbar.addEventListener('click', (ev) => {
  const a = (ev.target as HTMLElement).closest('button')?.dataset.a;
  if (a === '+') scaleSelected(1);
  if (a === '-') scaleSelected(-1);
  if (a === 'del' && selected) remove(selected);
});

// ---------- Form fields ----------

// ZapfDingbats ✓ is 0.755em wide; its visual center sits ~0.555em below the line-box top.
function addCheck(pageIndex: number, cx: number, cy: number, fontSize: number, field?: number) {
  add({ id: String(nextId++), type: 'check', pageIndex, x: cx - 0.378 * fontSize, y: cy - 0.555 * fontSize, fontSize, field });
}

// Click (or Tab) into a field: reuse its element, toggle a checkbox, or create a snapped element.
function fill(pageIndex: number, field: number) {
  const f = pages[pageIndex].fields[field];
  const existing = els.find((e) => e.pageIndex === pageIndex && e.field === field);
  if (f.kind === 'check') return existing ? remove(existing.id) : addCheck(pageIndex, f.x + f.w / 2, f.y + f.h / 2, clamp(f.h * 0.9, 8, 18), field);
  if (existing) return edit(existing, nodes.get(existing.id)!);
  const base = { id: String(nextId++), pageIndex, field, text: '', maxLen: f.maxLen || undefined };
  const fs = clamp(Math.round(f.h * 0.62), 7, 12);
  if (f.kind === 'comb') add({ ...base, type: 'comb', x: f.x, y: f.y, w: f.w, h: f.h, fontSize: clamp(f.h * 0.62, 7, 12) });
  else if (f.multiline) add({ ...base, type: 'text', x: f.x + 2, y: f.y + 2, w: f.w - 4, fontSize: 10 });
  else add({ ...base, type: 'text', x: f.x + 2, y: f.y + (f.h - 1.2 * fs) / 2, fontSize: fs });
}

function tabFrom(pageIndex: number, field: number, dir: 1 | -1) {
  const order = pages.flatMap((p, pi) => p.fields.flatMap((f, i) => (f.kind === 'check' ? [] : [[pi, i]])));
  const at = order.findIndex(([pi, i]) => pi === pageIndex && i === field);
  const [pi, i] = order[(at + dir + order.length) % order.length];
  fill(pi, i);
}

// ---------- Modes ----------

function setMode(m: typeof mode, savedSig = false) {
  mode = m;
  document.body.classList.toggle('placing', m !== 'none');
  if (m === 'check') hintEl.textContent = 'Click where you want the check mark';
  else if (m === 'sig' && savedSig) hintEl.innerHTML = 'Click to place your signature · <a href="#" id="draw-new">Draw new</a>';
  else if (m === 'sig') hintEl.textContent = 'Click where you want your signature';
  else hintEl.textContent = hasFields ? 'Click a field to fill it, or click anywhere to type' : 'Click anywhere on the page to type';
}

async function drawNew() {
  setMode('none');
  // On a shared device the user can wipe the saved signature from the modal.
  const forget = savedSig()
    ? () => {
        try {
          localStorage.removeItem(SIG_KEY);
        } catch {}
        sig = null;
      }
    : undefined;
  const s = await drawSignature(forget);
  if (!s) return;
  try {
    localStorage.setItem(SIG_KEY, JSON.stringify(s));
  } catch {
    // storage full / disabled: still usable this session
  }
  sig = s;
  setMode('sig');
}

function savedSig(): Sig | null {
  try {
    const s = JSON.parse(localStorage.getItem(SIG_KEY) ?? 'null');
    const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
    // Only ever used as <img>.src / embedPng, but reject anything that isn't a PNG data URL.
    if (typeof s?.dataUrl === 'string' && s.dataUrl.startsWith('data:image/png;base64,') && ok(s.w) && ok(s.h))
      return { dataUrl: s.dataUrl, w: s.w, h: s.h };
    localStorage.removeItem(SIG_KEY);
    return null;
  } catch {
    return null;
  }
}

$('#check').addEventListener('click', () => setMode(mode === 'check' ? 'none' : 'check'));
$('#sign').addEventListener('click', () => {
  if (mode === 'sig') return setMode('none');
  sig = savedSig();
  if (sig) setMode('sig', true);
  else drawNew();
});
hintEl.addEventListener('click', (ev) => {
  if ((ev.target as HTMLElement).id !== 'draw-new') return;
  ev.preventDefault();
  drawNew();
});

pagesEl.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  const pageEl = t.closest<HTMLElement>('.page');
  if (!pageEl) return setMode('none'); // gray margin cancels placing
  if (t.closest('.toolbar')) return;
  const pageIndex = Number(pageEl.dataset.index);
  const p = pages[pageIndex];
  const r = pageEl.getBoundingClientRect();
  const x = (ev.clientX - r.left) / p.scale;
  const y = (ev.clientY - r.top) / p.scale;
  const field = p.fields.findIndex((f) => inside(f, x, y));
  if (mode === 'check') {
    if (p.fields[field]?.kind === 'check') fill(pageIndex, field);
    else addCheck(pageIndex, x, y, 14);
    return setMode('none');
  }
  if (mode === 'sig' && sig) {
    const ratio = sig.w / sig.h;
    const f = p.fields[field]?.kind === 'check' ? undefined : p.fields[field];
    let w = Math.min(120, 0.3 * p.viewport1.width);
    let h = w / ratio;
    if (f) (h = 1.6 * f.h), (w = Math.min(h * ratio, f.w)), (h = w / ratio);
    const id = String(nextId++);
    add({ id, type: 'sig', pageIndex, x: f ? f.x : x, y: (f ? f.y + f.h / 2 : y) - h / 2, w, h, dataUrl: sig.dataUrl });
    return setMode('none');
  }
  if (t.closest('.el')) return;
  if (field >= 0) return fill(pageIndex, field);
  add({ id: String(nextId++), type: 'text', pageIndex, x, y: y - 7.2, fontSize: 12, text: '' });
});

// ---------- Global input ----------

addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (mode !== 'none') return setMode('none');
    if (editing()) (document.activeElement as HTMLElement).blur();
    select(null);
  } else if (ev.key === 'Delete' && selected && !editing()) {
    ev.preventDefault();
    remove(selected);
  } else if (ev.key === 'Backspace' && !editing()) ev.preventDefault(); // older WebKit navigates back
});

let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (pages.length && window.innerWidth !== lastWidth) layout();
  }, 150);
});

addEventListener('dragover', (ev) => {
  ev.preventDefault();
  document.body.classList.add('dragging');
});
addEventListener('dragleave', (ev) => {
  if (!ev.relatedTarget) document.body.classList.remove('dragging');
});
addEventListener('drop', (ev) => {
  ev.preventDefault();
  document.body.classList.remove('dragging');
  const f = ev.dataTransfer?.files[0];
  if (f) openFile(f);
});

emptyEl.addEventListener('click', () => fileInput.click());
$('#open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (f) openFile(f);
});

downloadBtn.addEventListener('click', async () => {
  if (!bytes) return;
  if (editing()) (document.activeElement as HTMLElement).blur();
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Working…';
  try {
    const out = await exportPdf(bytes, els.filter((e) => !typed(e) || e.text?.trim()), pages, password);
    const url = URL.createObjectURL(new Blob([out as BlobPart], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}-signed.pdf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    cleanState = JSON.stringify(els);
  } catch (err) {
    console.error(err);
    alert("Sorry, the PDF couldn't be created.");
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Download';
  }
});
