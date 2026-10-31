import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, StandardFonts, degrees, rgb,
  type PDFFont, type PDFImage, type PDFObject,
} from '@cantoo/pdf-lib';
import type { PageViewport } from 'pdfjs-dist';

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
  ocVisible: Set<string> = new Set(), // pdf.js ids ("12R") of /OC widgets pdf.js drew; any other /OC widget is blank
): Promise<Uint8Array> {
  // Decrypts owner- and user-password PDFs; the output is saved unencrypted.
  const doc = await PDFDocument.load(originalBytes, { password, preserveXFA: true });
  // Bake form fields into the page so our text isn't hidden under widgets and fields aren't left live.
  // XFA is dropped explicitly (pdf-lib would otherwise warn); viewers would show it instead of the flattened page.
  pinShownAppearances(doc, ocVisible);
  try {
    const form = doc.getForm();
    form.deleteXFA();
    form.flatten({ updateFieldAppearances: false });
  } catch {
    // Never fall back to a flatten that could print what wasn't shown: drop the widgets instead.
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) if (annots!.lookupMaybe(i, PDFDict)?.get(PDFName.of('Subtype')) === PDFName.of('Widget')) annots!.remove(i);
    }
  }
  stripActiveContent(doc);
  doc.catalog.delete(PDFName.of('Perms')); // usage-rights signatures (/UR3) are invalid once the file is modified
  const docPages = doc.getPages();
  const images = new Map<string, PDFImage>();
  const fonts = new Map<string, PDFFont>();
  const font = async (name: StandardFonts) => fonts.get(name) ?? fonts.set(name, await doc.embedFont(name)).get(name)!;

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
      if (!img) images.set(e.dataUrl!, (img = await doc.embedPng(e.dataUrl!)));
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
  dropUnreachable(doc); // flattened field dicts (with their /V values) and removed actions must not linger in the file
  return doc.save();
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
        const pick = nd instanceof PDFDict ? nd.get(state instanceof PDFName ? state : Off) : n;
        if (pick instanceof PDFRef && ctx.lookup(pick) instanceof PDFStream) shown = pick;
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
      annot.delete(AA);
      const action = annot.lookupMaybe(A, PDFDict);
      if (action && !allowed(action)) annots!.remove(i);
      else action?.delete(PDFName.of('Next'));
    }
  }
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
