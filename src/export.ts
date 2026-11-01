import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, StandardFonts, degrees, rgb,
  beginMarkedContent, concatTransformationMatrix, drawObject, endMarkedContent, popGraphicsState, pushGraphicsState,
  type PDFFont, type PDFImage, type PDFObject,
} from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { loadAsPdfJsSees } from './xref';

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
  report?: (page: number, differing: number, maxTile: number) => void, // per-page check result (tests)
): Promise<Uint8Array> {
  // pdf-lib must hold exactly the objects pdf.js resolved through the xref (see xref.ts); anything else is refused.
  // Decrypts owner- and user-password PDFs; the output is saved unencrypted.
  let doc: PDFDocument;
  try {
    doc = (await loadAsPdfJsSees(originalBytes, password)).doc;
  } catch (err) {
    throw new UnsafeExport(String(err));
  }
  if (doc.getPageCount() !== original.numPages) throw new UnsafeExport('pdf-lib and pdf.js disagree on the page count');
  // Flattened widget appearances are wrapped in this (unguessable) marked-content tag so the text check can tell them apart.
  const widgetTag = `FIMPW${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
  // Bake form fields into the page so our text isn't hidden under widgets and fields aren't left live.
  // XFA is dropped explicitly (pdf-lib would otherwise warn); viewers would show it instead of the flattened page.
  let blank: Set<string>;
  ({ doc, blank } = await pdfjsAppearances(doc));
  pinShownAppearances(doc, oc.widgets, widgetTag, blank);
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
  await guard(original, checked.slice(), widgetTag, report); // pdf.js takes ownership of (detaches) the buffer it is given
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
function pinShownAppearances(doc: PDFDocument, ocVisible: Set<string>, tag: string, blank = new Set<string>()) {
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
    // Field-tree widgets on no page (editors that rewrite a field but leave the page pointing at the old widget) are
    // never drawn by pdf.js; take them out of the field tree so the flatten doesn't try to place them.
    const offPage = new Set([...widgets].filter(([, ref]) => !ref).map(([d]) => d));
    const prune = (kids: PDFArray | undefined, depth = 0) => {
      for (let i = (kids?.size() ?? 0) - 1; i >= 0 && depth < 32; i--) {
        const k = kids!.lookupMaybe(i, PDFDict);
        if (k && offPage.has(k)) kids!.remove(i);
        else prune(k?.lookupMaybe(PDFName.of('Kids'), PDFArray), depth + 1);
      }
    };
    if (offPage.size) prune(doc.getForm().acroForm.dict.lookupMaybe(PDFName.of('Fields'), PDFArray));
  } catch {}
  const button = (d: PDFDict | undefined, depth = 0): boolean =>
    !!d && depth < 32 && (d.has(PDFName.of('FT')) ? d.get(PDFName.of('FT')) === PDFName.of('Btn') : button(d.lookupMaybe(PDFName.of('Parent'), PDFDict), depth + 1));
  for (const [dict, ref] of widgets) {
    let shown: PDFObject | undefined = empty;
    try {
      const flags = Number(String(dict.lookup(PDFName.of('F')) ?? 0));
      const id = ref && `${ref.objectNumber}R${ref.generationNumber || ''}`;
      const ocShown = !dict.has(PDFName.of('OC')) || (!!id && ocVisible.has(id));
      if (ref && !(flags & 2) && !(flags & 32) && ocShown && !blank.has(id!)) {
        const n = dict.lookupMaybe(AP, PDFDict)?.get(N);
        const nd = n && ctx.lookup(n);
        const state = dict.get(PDFName.of('AS'));
        // Buttons without /AS draw /Off (as pdf.js does); any other widget draws a state only if /AS names one.
        const key = state instanceof PDFName ? state : button(dict) ? Off : undefined;
        const pick = nd instanceof PDFDict ? key && nd.get(key) : n;
        if (pick instanceof PDFRef && ctx.lookup(pick) instanceof PDFStream) shown = fitToRect(doc, dict, pick, tag);
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
  // Document-level attachments aren't shown on any page; attachments with a visible icon (FileAttachment) stay.
  doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.delete(PDFName.of('EmbeddedFiles'));
  doc.catalog.delete(PDFName.of('AF'));
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
      // Annotations pdf.js doesn't draw on the page but other viewers show (pop-ups, media, 3D, icon-less notes).
      // A note with an appearance is drawn, so it stays - without its pop-up text.
      const subtype = String(annot.get(PDFName.of('Subtype')));
      if (/^\/(Popup|Sound|Movie|Screen|3D|RichMedia|Projection|TrapNet)$/.test(subtype) || (subtype === '/Text' && !annot.has(PDFName.of('AP')))) {
        annots!.remove(i);
        continue;
      }
      if (subtype === '/Text') for (const k of ['Contents', 'RC', 'T']) annot.delete(PDFName.of(k));
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
function fitToRect(doc: PDFDocument, widget: PDFDict, appearance: PDFRef, tag: string): PDFRef {
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
      [beginMarkedContent(tag), pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, -minX * sx, -minY * sy), drawObject('Ap'), popGraphicsState(), endMarkedContent()],
      // The appearance's own /BBox does the clipping (as in pdf.js); a tight wrapper box would add a second clip edge.
      { BBox: [-rectW, -rectH, 2 * rectW, 2 * rectH], Resources: { XObject: { Ap: appearance } } },
    ),
  );
}

// With /NeedAppearances, pdf.js draws text/choice fields from their /V instead of the stored /AP. Let pdf.js write
// those appearances itself (same _getAppearance code it displays with): clear the flag, put each field's value into
// pdf.js's annotation storage, and save - pdf.js then emits an /AP stream per field as an incremental update, which
// goes back through the xref layer. (saveDocument alone keeps NeedAppearances and writes no appearances.)
async function pdfjsAppearances(doc: PDFDocument): Promise<{ doc: PDFDocument; blank: Set<string> }> {
  const blank = new Set<string>(); // widgets pdf.js draws nothing for under NeedAppearances (empty choice fields)
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (String(acroForm?.lookup(PDFName.of('NeedAppearances'))) !== 'true') return { doc, blank };
  acroForm!.delete(PDFName.of('NeedAppearances'));
  const task = openPdf(await doc.save({ updateFieldAppearances: false, useObjectStreams: false }));
  try {
    const pd = await task.promise;
    for (let i = 1; i <= pd.numPages; i++)
      for (const a of await (await pd.getPage(i)).getAnnotations()) {
        // Exactly the widgets pdf.js regenerates for display: text/choice fields whose value isn't undefined/null
        // (worker: hasAppearance ||= needAppearances && fieldValue !== undefined && fieldValue !== null) - empty
        // strings included (they get pdf.js's border/background box). Passing the widget's current rotation is a
        // no-op that stops save() from skipping a value that didn't change.
        if (a.subtype !== 'Widget' || (a.fieldType !== 'Tx' && a.fieldType !== 'Ch') || a.fieldValue === undefined || a.fieldValue === null) continue;
        // An empty choice field is drawn as nothing on screen (its save path would write a box): blank it.
        if (a.fieldType === 'Ch' && !(Array.isArray(a.fieldValue) ? a.fieldValue.length : String(a.fieldValue))) blank.add(a.id);
        else pd.annotationStorage.setValue(a.id, { value: a.fieldValue, rotation: a.rotation ?? 0 });
      }
    return { doc: (await loadAsPdfJsSees(await pd.saveDocument(), '')).doc, blank };
  } finally {
    task.destroy();
  }
}

// Render every page of the original and of the candidate with pdf.js and compare pixels. Anything that can't be
// shown to match - including any failure of the check itself - refuses the export.
async function guard(original: PDFDocumentProxy, candidate: Uint8Array, widgetTag: string, report?: (page: number, differing: number, maxTile: number) => void) {
  const task = openPdf(candidate);
  const canvases = [0, 1].map(() => {
    const c = document.createElement('canvas');
    c.getContext('2d', { willReadFrequently: true }); // pdf.js reuses this context; we read it back
    return c;
  });
  try {
    const copy = await task.promise;
    if (copy.numPages !== original.numPages) throw new Error('page count');
    if (!sameOutline(await original.getOutline(), await copy.getOutline())) throw new Error('outline differs');
    const zoom = original.numPages > 50 ? 1.5 : 2.5; // device pixels per PDF point
    for (let i = 1; i <= original.numPages; i++) {
      const [a, b] = await Promise.all([original.getPage(i), copy.getPage(i)]);
      const va = a.getViewport({ scale: 1 }), vb = b.getViewport({ scale: 1 });
      if (Math.abs(va.width - vb.width) > 0.5 || Math.abs(va.height - vb.height) > 0.5) throw new Error('page size');
      // Same canvas budget as the editor: ≤ 16M pixels and ≤ 16384 px per side.
      const scale = Math.min(zoom, Math.sqrt(16e6 / (va.width * va.height)), 16384 / Math.max(va.width, va.height));
      await sameTextAndAnnotations(a, b, original, copy, widgetTag, i);
      // Canvas text rendering is not perfectly deterministic (a font that finishes loading mid-render, GPU
      // anti-aliasing): a mismatch is measured twice and only a repeatable one counts. Planted content repeats.
      let { differing, maxTile } = await compare(a, b, scale, canvases);
      if (differing > 0 || maxTile >= 8) ({ differing, maxTile } = await compare(a, b, scale, canvases));
      report?.(i, differing, maxTile);
      if (differing > 0) throw new Error(`page ${i}: ${differing} pixels differ`);
      if (maxTile >= 8) throw new Error(`page ${i}: faint change (${maxTile} pixels in one tile)`);
    }
  } catch (err) {
    throw new UnsafeExport(String(err));
  } finally {
    task.destroy();
    for (const c of canvases) c.width = c.height = 0;
  }
}

// What a renderer would show isn't all a PDF says: compare the text pdf.js extracts (invisible OCR layers, white text)
// and the annotations it reports (link targets, attachments). Flattened widgets add their own text, inside our tag;
// annotations may only disappear (we strip some), never appear or change.
async function sameTextAndAnnotations(a: PDFPageProxy, b: PDFPageProxy, da: PDFDocumentProxy, db: PDFDocumentProxy, widgetTag: string, i: number) {
  const key = (t: { str: string; transform: number[] }) => `${t.str}@${t.transform.map((n) => n.toFixed(2)).join(',')}`;
  const ta = (await a.getTextContent()).items.map((t) => key(t as { str: string; transform: number[] }));
  const tb: string[] = [];
  const stack: string[] = [];
  for (const t of (await b.getTextContent({ includeMarkedContent: true })).items as Array<Record<string, any>>) {
    if (t.type === 'beginMarkedContent' || t.type === 'beginMarkedContentProps') stack.push(t.tag);
    else if (t.type === 'endMarkedContent') stack.pop();
    else if (!stack.includes(widgetTag)) tb.push(key(t as { str: string; transform: number[] }));
  }
  if (ta.length !== tb.length || ta.some((k, j) => k !== tb[j])) throw new Error(`page ${i}: text differs`);
  // File attachments: pdf.js 6 returns the bytes separately, by fileId.
  const content = async (d: PDFDocumentProxy, x: Record<string, any>) => {
    if (!x.fileId) return null;
    const c = (await d.getAttachmentContent(x.fileId)) as unknown as { content?: Uint8Array } | Uint8Array | null;
    const bytes = c instanceof Uint8Array ? c : c?.content;
    return bytes ? await hash(bytes) : 'unreadable';
  };
  const sig = async (d: PDFDocumentProxy, x: Record<string, any>) =>
    JSON.stringify([x.subtype, x.rect?.map((n: number) => n.toFixed(2)), x.url ?? null, x.unsafeUrl ?? null, x.dest ?? null, x.file?.filename ?? null, await content(d, x)]);
  const before = new Set<string>();
  for (const x of await a.getAnnotations()) if (x.subtype !== 'Widget') before.add(await sig(da, x));
  for (const x of await b.getAnnotations()) if (x.subtype !== 'Widget' && !before.has(await sig(db, x))) throw new Error(`page ${i}: annotation differs`);
}

// SHA-256 of an attachment's bytes (collision-resistant, unlike a short checksum).
const hash = async (b: Uint8Array) =>
  `${b.length}:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('')}`;

// Bookmarks: same titles and nesting; a target may be gone (we strip non-navigation actions) but never different.
type OutlineItem = { title: string; dest?: unknown; url?: string | null; unsafeUrl?: string; action?: string | null; items: OutlineItem[] };
function sameOutline(a: OutlineItem[] | null, b: OutlineItem[] | null): boolean {
  if (!a?.length || !b?.length) return !a?.length && !b?.length;
  return a.length === b.length && a.every((x, i) => {
    const y = b[i];
    const target = (o: OutlineItem) => [o.dest, o.url, o.unsafeUrl, o.action].map((v) => JSON.stringify(v ?? null));
    const [tx, ty] = [target(x), target(y)];
    return x.title === y.title && ty.every((v, k) => v === 'null' || v === tx[k]) && sameOutline(x.items, y.items);
  });
}

// Render page a (original) and b (candidate) at `scale` and count differing pixels: channel difference > 24, and the
// most pixels with difference > 2 in any 16×16 tile. Edge antialiasing is forgiven: the original draws widgets on the
// annotation path, the candidate as page content, and GPU canvas rasterizes their edges with slightly different
// coverage (or a pixel off). A difference is an edge difference when both images have an edge there (3×3 contrast) and
// each pixel lies within the other image's 3×3 range. Flat areas forgive nothing, so planted content is only ever
// forgiven in a one-pixel band along an edge both images already have.
async function compare(a: PDFPageProxy, b: PDFPageProxy, scale: number, canvases: HTMLCanvasElement[]) {
  await rasterize(a, scale, canvases[0]);
  await rasterize(b, scale, canvases[1]);
  // Compare in strips (with one row of context above and below) so a 2.5× page never needs two full-page pixel copies.
  const [ca, cb] = canvases.map((c) => c.getContext('2d')!);
  const { width, height } = canvases[0];
  const tilesX = Math.ceil(width / 16);
  let differing = 0;
  let maxTile = 0;
  for (let y = 0; y < height; y += 256) {
    const h = Math.min(256, height - y);
    const top = Math.max(0, y - 1);
    const rows = Math.min(height, y + h + 1) - top;
    const pa = ca.getImageData(0, top, width, rows).data;
    const pb = cb.getImageData(0, top, width, rows).data;
    // Per-channel range of q's 3×3 neighbourhood around (x, r), or undefined when it has no edge (luma contrast < 32).
    const range = (q: Uint8ClampedArray, x: number, r: number) => {
      const lo = [255, 255, 255], hi = [0, 0, 0];
      let ylo = 255, yhi = 0;
      for (let rr = Math.max(0, r - 1); rr <= Math.min(rows - 1, r + 1); rr++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          const j = (rr * width + xx) * 4;
          for (let c = 0; c < 3; c++) (lo[c] = Math.min(lo[c], q[j + c])), (hi[c] = Math.max(hi[c], q[j + c]));
          const l = 0.299 * q[j] + 0.587 * q[j + 1] + 0.114 * q[j + 2];
          (ylo = Math.min(ylo, l)), (yhi = Math.max(yhi, l));
        }
      return yhi - ylo >= 32 ? { lo, hi } : undefined;
    };
    const inside = (p: Uint8ClampedArray, k: number, g: { lo: number[]; hi: number[] }) =>
      [0, 1, 2].every((c) => p[k + c] >= g.lo[c] - 16 && p[k + c] <= g.hi[c] + 16);
    const edge = (x: number, r: number, k: number) => {
      const ga = range(pa, x, r), gb = ga && range(pb, x, r);
      return !!gb && inside(pa, k, gb) && inside(pb, k, ga!);
    };
    const tiles = new Uint16Array(tilesX * 16);
    for (let r = y - top; r < y - top + h; r++)
      for (let x = 0; x < width; x++) {
        const k = (r * width + x) * 4;
        const d = Math.max(Math.abs(pa[k] - pb[k]), Math.abs(pa[k + 1] - pb[k + 1]), Math.abs(pa[k + 2] - pb[k + 2]));
        if (d <= 2 || edge(x, r, k)) continue;
        if (d > 24) differing++;
        const t = ((r - (y - top)) >> 4) * tilesX + (x >> 4);
        maxTile = Math.max(maxTile, ++tiles[t]);
      }
  }
  return { differing, maxTile };
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
