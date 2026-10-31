import {
  PDFArray, PDFDict, PDFDocument, PDFDropdown, PDFName, PDFOptionList, PDFRef, PDFStream, PDFTextField, StandardFonts, degrees, rgb,
  concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState,
  type PDFFont, type PDFImage, type PDFObject,
} from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';

// One set of pdf.js options for the editor and for the export check, so both see the file the same way.
export const pdfOptions = {
  standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
  wasmUrl: `${import.meta.env.BASE_URL}wasm/`, // JPEG2000 / JBIG2 / ICC decoders
  verbosity: pdfjs.VerbosityLevel.ERRORS,
};

export const openPdf = (data: Uint8Array, password = '') => pdfjs.getDocument({ data, password, ...pdfOptions });

/** The flattened file would not look like what pdf.js showed (or the check itself could not run). */
export class UnsafeExport extends Error {}

export type El = {
  id: string;
  type: 'text' | 'check' | 'sig' | 'comb';
  pageIndex: number;
  x: number;
  y: number;
  w?: number; // sig/comb size; for text, a fixed wrap width (multiline fields)
  h?: number;
  fontSize?: number;
  text?: string;
  dataUrl?: string;
  maxLen?: number; // input cap; for comb, the number of cells
  field?: number; // index of the form field this element was snapped to
};

export async function exportPdf(
  originalBytes: Uint8Array,
  elements: El[],
  pages: { viewport1: PageViewport }[],
  password = '',
  // Optional content as pdf.js shows it: /OC widgets it drew (pdf.js ids like "12R"; any other /OC widget is blank)
  // and the layers it hides (forced OFF for every viewer and for printing).
  oc: { widgets: Set<string>; hiddenGroups: Set<string> },
  original: PDFDocumentProxy, // the document as the editor shows it
  onStage: (stage: 'checking' | 'saving') => void = () => {},
  report?: (page: number, differing: number, limit: number) => void, // per-page check result (tests)
): Promise<Uint8Array> {
  // Decrypts owner- and user-password PDFs; the output is saved unencrypted.
  const doc = await PDFDocument.load(originalBytes, { password, preserveXFA: true });
  // Bake form fields into the page so our text isn't hidden under widgets and fields aren't left live.
  // XFA is dropped explicitly (pdf-lib would otherwise warn); viewers would show it instead of the flattened page.
  await regenerateIfNeeded(doc);
  pinShownAppearances(doc, oc.widgets);
  try {
    const form = doc.getForm();
    form.deleteXFA();
    form.flatten({ updateFieldAppearances: false });
  } catch {
    // Never fall back to a flatten that could print what wasn't shown: drop the widgets, and the form with its values.
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) if (annots!.lookupMaybe(i, PDFDict)?.get(PDFName.of('Subtype')) === PDFName.of('Widget')) annots!.remove(i);
    }
    doc.catalog.delete(PDFName.of('AcroForm'));
  }
  printFollowsView(doc, oc.hiddenGroups);
  stripActiveContent(doc);
  doc.catalog.delete(PDFName.of('Perms')); // usage-rights signatures (/UR3) are invalid once the file is modified

  // The guard: the flattened file, before our overlays, must render like the original. No other path to a download.
  onStage('checking');
  dropUnreachable(doc);
  // Never let pdf-lib rebuild appearances while saving (the form may be gone or malformed after the fallback).
  const checked = await doc.save({ updateFieldAppearances: false });
  await guard(original, checked.slice(), report); // pdf.js takes ownership of (detaches) the buffer it is given
  onStage('saving');
  // Overlays go onto exactly the bytes that passed the check (a fresh load also gives pdf-lib fresh content streams;
  // streams written by the first save are cached and would silently drop anything drawn into them afterwards).
  const out = await PDFDocument.load(checked);
  const docPages = out.getPages();
  const images = new Map<string, PDFImage>();
  const fonts = new Map<string, PDFFont>();
  const font = async (name: StandardFonts) => fonts.get(name) ?? fonts.set(name, await out.embedFont(name)).get(name)!;

  for (const e of elements) {
    const page = docPages[e.pageIndex];
    const vp = pages[e.pageIndex].viewport1;
    const rotate = degrees(vp.rotation);
    const size = e.fontSize!;
    // (x, y) in display points, y = top of a 1.2-line-height line box.
    const draw = (text: string, x: number, top: number, f: PDFFont) => {
      const [px, py] = vp.convertToPdfPoint(x, top + 0.6 * size + 0.3 * size);
      page.drawText(text, { x: px, y: py, size, font: f, rotate, color: rgb(0, 0, 0) });
    };

    if (e.type === 'sig') {
      let img = images.get(e.dataUrl!);
      if (!img) images.set(e.dataUrl!, (img = await out.embedPng(e.dataUrl!)));
      const [x, y] = vp.convertToPdfPoint(e.x, e.y + e.h!);
      page.drawImage(img, { x, y, width: e.w!, height: e.h!, rotate });
      continue;
    }
    if (e.type === 'check') {
      draw('✓', e.x, e.y, await font(StandardFonts.ZapfDingbats));
      continue;
    }

    const f = await font(e.type === 'comb' ? StandardFonts.Courier : StandardFonts.Helvetica);
    // Standard fonts only cover their own small charset; anything else would make pdf-lib throw.
    const ok = new Set(f.getCharacterSet());
    const clean = (s: string) => Array.from(s).map((ch) => (ok.has(ch.codePointAt(0)!) ? ch : '?'));

    if (e.type === 'comb') {
      const cell = e.w! / e.maxLen!;
      const top = e.y + (e.h! - 1.2 * size) / 2;
      clean(e.text ?? '').forEach((ch, i) => draw(ch, e.x + i * cell + (cell - f.widthOfTextAtSize(ch, size)) / 2, top, f));
      continue;
    }

    // Greedy word wrap at e.w (multiline fields), matching the editor's pre-wrap box.
    const wrap = (line: string) => {
      if (!e.w) return [line];
      const out: string[] = [];
      let cur = '';
      for (const word of line.split(' ')) {
        const next = cur ? `${cur} ${word}` : word;
        if (cur && f.widthOfTextAtSize(next, size) > e.w) out.push(cur), (cur = word);
        else cur = next;
      }
      return [...out, cur];
    };
    const lines = (e.text ?? '').split(/\r?\n/).flatMap((l) => wrap(clean(l).join('')));
    lines.forEach((line, i) => line && draw(line, e.x, e.y + 1.2 * size * i, f));
  }
  return out.save({ updateFieldAppearances: false });
}

// What you see is what you sign: make every widget's appearance exactly what pdf.js drew in the editor, so the
// flatten (and any viewer, for widgets pdf-lib leaves as annotations) shows nothing else. pdf.js skips Hidden/NoView
// widgets and those on hidden optional-content layers, and draws the /AS state; pdf-lib would draw them all, pick
// button states by /V, and regenerate missing appearances. Every widget on every page counts, not just the field tree.
function pinShownAppearances(doc: PDFDocument, ocVisible: Set<string>) {
  const ctx = doc.context;
  const [AP, N, Off] = ['AP', 'N', 'Off'].map((k) => PDFName.of(k));
  const empty = ctx.register(ctx.formXObject([], { BBox: [0, 0, 0, 0] }));
  const widgets = new Map<PDFDict, PDFRef | undefined>();
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const ref = annots!.get(i);
      const dict = annots!.lookupMaybe(i, PDFDict);
      if (dict?.get(PDFName.of('Subtype')) === PDFName.of('Widget')) widgets.set(dict, ref instanceof PDFRef ? ref : undefined);
    }
  }
  try {
    for (const f of doc.getForm().getFields()) for (const w of f.acroField.getWidgets()) if (!widgets.has(w.dict)) widgets.set(w.dict, undefined); // not on any page: never drawn
  } catch {}
  const button = (d: PDFDict | undefined, depth = 0): boolean =>
    !!d && depth < 32 && (d.has(PDFName.of('FT')) ? d.get(PDFName.of('FT')) === PDFName.of('Btn') : button(d.lookupMaybe(PDFName.of('Parent'), PDFDict), depth + 1));
  for (const [dict, ref] of widgets) {
    let shown: PDFObject | undefined = empty;
    try {
      const flags = Number(String(dict.lookup(PDFName.of('F')) ?? 0));
      const ocShown = !dict.has(PDFName.of('OC')) || (!!ref && ocVisible.has(`${ref.objectNumber}R${ref.generationNumber || ''}`));
      if (ref && !(flags & 2) && !(flags & 32) && ocShown) {
        const n = dict.lookupMaybe(AP, PDFDict)?.get(N);
        const nd = n && ctx.lookup(n);
        const state = dict.get(PDFName.of('AS'));
        // Buttons without /AS draw /Off (as pdf.js does); any other widget draws a state only if /AS names one.
        const key = state instanceof PDFName ? state : button(dict) ? Off : undefined;
        const pick = nd instanceof PDFDict ? key && nd.get(key) : n;
        if (pick instanceof PDFRef && ctx.lookup(pick) instanceof PDFStream) shown = fitToRect(doc, dict, pick);
      }
    } catch {
      shown = empty;
    }
    try {
      dict.set(AP, ctx.obj({ N: button(dict) ? { Off: shown } : shown }));
    } catch {
      dict.set(AP, ctx.obj({ N: empty }));
    }
  }
}

// The output is a flat signed document: only navigation survives (GoTo, URI to the web or mail, Named). Everything
// else - scripts, launches, submission, media, remote/embedded go-tos, chained /Next actions - is removed.
function stripActiveContent(doc: PDFDocument) {
  const [A, AA, S] = ['A', 'AA', 'S'].map((k) => PDFName.of(k));
  const allowed = (a: PDFDict | undefined) => {
    const s = String(a?.get(S));
    if (s === '/URI') return /^\(?(https?:|mailto:)/i.test(String(a!.lookup(PDFName.of('URI')) ?? '').replace(/^<.*>$/, ''));
    return s === '/GoTo' || s === '/Named';
  };
  doc.catalog.delete(PDFName.of('OpenAction'));
  doc.catalog.delete(AA);
  doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.delete(PDFName.of('JavaScript'));
  // Outline items: keep the tree, drop any action that isn't plain navigation.
  const seen = new Set<PDFDict>();
  const outline = (item: PDFDict | undefined) => {
    for (let it = item; it && !seen.has(it); it = it.lookupMaybe(PDFName.of('Next'), PDFDict)) {
      seen.add(it);
      const a = it.lookupMaybe(A, PDFDict);
      if (a && !allowed(a)) it.delete(A);
      else a?.delete(PDFName.of('Next'));
      outline(it.lookupMaybe(PDFName.of('First'), PDFDict));
    }
  };
  outline(doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)?.lookupMaybe(PDFName.of('First'), PDFDict));
  for (const page of doc.getPages()) {
    page.node.delete(AA);
    const annots = page.node.Annots();
    for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) {
      const annot = annots!.lookupMaybe(i, PDFDict);
      if (!annot) continue;
      // Annotations pdf.js doesn't draw on the page but other viewers show (notes, pop-ups, media, 3D).
      if (/^\/(Text|Popup|Sound|Movie|Screen|3D|RichMedia|Projection|TrapNet)$/.test(String(annot.get(PDFName.of('Subtype'))))) {
        annots!.remove(i);
        continue;
      }
      annot.delete(PDFName.of('Popup'));
      annot.delete(AA);
      const action = annot.lookupMaybe(A, PDFDict);
      if (action && !allowed(action)) annots!.remove(i);
      else action?.delete(PDFName.of('Next'));
    }
  }
}

// Optional content: viewers and printers may switch layers by usage (/AS: print vs view) or alternate configs.
// Pin the default config to what pdf.js showed: no usage rules, no alternates, every hidden layer OFF.
function printFollowsView(doc: PDFDocument, hiddenGroups: Set<string>) {
  const ocp = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  if (!ocp) return;
  ocp.delete(PDFName.of('Configs'));
  const d = ocp.lookupMaybe(PDFName.of('D'), PDFDict) ?? ocp.context.obj({});
  ocp.set(PDFName.of('D'), d);
  d.delete(PDFName.of('AS'));
  const id = (r: PDFObject) => (r instanceof PDFRef ? `${r.objectNumber}R${r.generationNumber || ''}` : '');
  const hidden = (ocp.lookupMaybe(PDFName.of('OCGs'), PDFArray)?.asArray() ?? []).filter((r) => hiddenGroups.has(id(r)));
  const on = d.lookupMaybe(PDFName.of('ON'), PDFArray);
  for (let i = (on?.size() ?? 0) - 1; i >= 0; i--) if (hiddenGroups.has(id(on!.get(i)))) on!.remove(i);
  const off = d.lookupMaybe(PDFName.of('OFF'), PDFArray) ?? ocp.context.obj([]);
  d.set(PDFName.of('OFF'), off);
  for (const r of hidden) if (!off.asArray().some((x) => id(x) === id(r))) off.push(r);
  // Lock them too, so a viewer's layers panel can't switch hidden content back on.
  const locked = d.lookupMaybe(PDFName.of('Locked'), PDFArray) ?? ocp.context.obj([]);
  d.set(PDFName.of('Locked'), locked);
  for (const r of hidden) if (!locked.asArray().some((x) => id(x) === id(r))) locked.push(r);
}

// PDF 32000 §12.5.5 (what pdf.js does): transform the appearance's /BBox by its /Matrix, then scale and translate
// that box onto the widget's /Rect. pdf-lib's flatten only translates, so wrap the appearance in a Rect-sized form
// XObject that applies the fit; pdf-lib then places the wrapper at the Rect origin.
function fitToRect(doc: PDFDocument, widget: PDFDict, appearance: PDFRef): PDFRef {
  const ctx = doc.context;
  const nums = (o: PDFObject | undefined) => (o instanceof PDFArray ? o.asArray().map((n) => Number(String(ctx.lookup(n)))) : undefined);
  const rect = nums(widget.lookup(PDFName.of('Rect')));
  const ap = (ctx.lookup(appearance) as PDFStream).dict;
  const bbox = nums(ap.lookup(PDFName.of('BBox')));
  const [a, b, c, d, e, f] = nums(ap.lookup(PDFName.of('Matrix'))) ?? [1, 0, 0, 1, 0, 0];
  if (!rect || !bbox || rect.length !== 4 || bbox.length !== 4 || [...rect, ...bbox, a, b, c, d, e, f].some((n) => !Number.isFinite(n))) throw new Error('geometry');
  const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  // pdf.js keeps this box in a Float32Array; match its rounding so the fit is bit-for-bit the same.
  const [minX, minY] = [Math.fround(Math.min(...pts.map((p) => p[0]))), Math.fround(Math.min(...pts.map((p) => p[1])))];
  const [boxW, boxH] = [Math.fround(Math.max(...pts.map((p) => p[0]))) - minX, Math.fround(Math.max(...pts.map((p) => p[1]))) - minY];
  const [rectW, rectH] = [Math.abs(rect[2] - rect[0]), Math.abs(rect[3] - rect[1])];
  if (!(boxW > 0 && boxH > 0 && rectW > 0 && rectH > 0)) throw new Error('empty geometry');
  const [sx, sy] = [rectW / boxW, rectH / boxH];
  // Always apply the fit, even when it is nearly the identity: pdf.js scales by e.g. 0.99999993, and at zero
  // tolerance that sub-pixel difference shows up in glyph anti-aliasing.
  return ctx.register(
    ctx.formXObject(
      [pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, -minX * sx, -minY * sy), drawObject('Ap'), popGraphicsState()],
      // The appearance's own /BBox does the clipping (as in pdf.js); a tight wrapper box would add a second clip edge.
      { BBox: [-rectW, -rectH, 2 * rectW, 2 * rectH], Resources: { XObject: { Ap: appearance } } },
    ),
  );
}

// With /NeedAppearances, viewers (and pdf.js) rebuild text/choice appearances from /V instead of the stored /AP.
async function regenerateIfNeeded(doc: PDFDocument) {
  try {
    const form = doc.getForm();
    if (String(form.acroForm.dict.lookup(PDFName.of('NeedAppearances'))) !== 'true') return;
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    for (const f of form.getFields()) {
      try {
        const v = f instanceof PDFTextField ? f.getText() : f instanceof PDFDropdown || f instanceof PDFOptionList ? f.getSelected().join('') : '';
        if (v?.trim()) (f as PDFTextField).updateAppearances(helvetica);
      } catch {}
    }
  } catch {}
}

// Render every page of the original and of the candidate with pdf.js and compare pixels. Anything that can't be
// shown to match - including any failure of the check itself - refuses the export.
async function guard(original: PDFDocumentProxy, candidate: Uint8Array, report?: (page: number, differing: number, limit: number) => void) {
  const task = openPdf(candidate);
  const canvases = [0, 1].map(() => {
    const c = document.createElement('canvas');
    c.getContext('2d', { willReadFrequently: true }); // pdf.js reuses this context; we read it back
    return c;
  });
  try {
    const copy = await task.promise;
    if (copy.numPages !== original.numPages) throw new Error('page count');
    const zoom = original.numPages > 50 ? 1.5 : 2.5; // device pixels per PDF point
    for (let i = 1; i <= original.numPages; i++) {
      const [a, b] = await Promise.all([original.getPage(i), copy.getPage(i)]);
      const va = a.getViewport({ scale: 1 }), vb = b.getViewport({ scale: 1 });
      if (Math.abs(va.width - vb.width) > 0.5 || Math.abs(va.height - vb.height) > 0.5) throw new Error('page size');
      // Same canvas budget as the editor: ≤ 16M pixels and ≤ 16384 px per side.
      const scale = Math.min(zoom, Math.sqrt(16e6 / (va.width * va.height)), 16384 / Math.max(va.width, va.height));
      await rasterize(a, scale, canvases[0]);
      await rasterize(b, scale, canvases[1]);
      // Compare in strips so a 2.5× page never needs two full-page pixel copies at once.
      const [ca, cb] = canvases.map((c) => c.getContext('2d')!);
      const { width, height } = canvases[0];
      let differing = 0;
      for (let y = 0; y < height; y += 256) {
        const h = Math.min(256, height - y);
        const pa = ca.getImageData(0, y, width, h).data;
        const pb = cb.getImageData(0, y, width, h).data;
        for (let k = 0; k < pa.length; k += 4)
          if (Math.abs(pa[k] - pb[k]) > 24 || Math.abs(pa[k + 1] - pb[k + 1]) > 24 || Math.abs(pa[k + 2] - pb[k + 2]) > 24) differing++;
      }
      // Zero tolerance: the clean corpus renders identically, and a single changed digit is only a few pixels.
      report?.(i, differing, 0);
      if (differing > 0) throw new Error(`page ${i}: ${differing} pixels differ`);
    }
  } catch (err) {
    throw new UnsafeExport(String(err));
  } finally {
    task.destroy();
    for (const c of canvases) c.width = c.height = 0;
  }
}

async function rasterize(page: PDFPageProxy, scale: number, canvas: HTMLCanvasElement) {
  const viewport = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvas, viewport, background: 'white', annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
}

function dropUnreachable(doc: PDFDocument) {
  const seen = new Set<PDFRef>();
  const walk = (o: PDFObject | undefined): void => {
    if (o instanceof PDFRef) {
      if (seen.has(o)) return;
      seen.add(o);
      walk(doc.context.lookup(o));
    } else if (o instanceof PDFDict) o.values().forEach(walk);
    else if (o instanceof PDFArray) o.asArray().forEach(walk);
    else if (o instanceof PDFStream) walk(o.dict);
  };
  walk(doc.context.trailerInfo.Root);
  walk(doc.context.trailerInfo.Info);
  for (const [ref] of doc.context.enumerateIndirectObjects()) if (!seen.has(ref)) doc.context.delete(ref);
}
