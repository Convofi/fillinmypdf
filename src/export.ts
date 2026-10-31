import {
  PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFRadioGroup, PDFRef, PDFStream, StandardFonts, degrees, rgb,
  type PDFFont, type PDFForm, type PDFImage, type PDFObject,
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
): Promise<Uint8Array> {
  // Decrypts owner- and user-password PDFs; the output is saved unencrypted.
  const doc = await PDFDocument.load(originalBytes, { password, preserveXFA: true });
  // Bake form fields into the page so our text isn't hidden under widgets and fields aren't left live.
  // XFA is dropped explicitly (pdf-lib would otherwise warn); viewers would show it instead of the flattened page.
  try {
    const form = doc.getForm();
    form.deleteXFA();
    try {
      pinShownAppearances(doc, form);
      form.flatten({ updateFieldAppearances: false });
    } catch {
      form.flatten();
    }
  } catch {}
  stripActiveContent(doc);
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

// What you see is what you sign: make each widget's flattened appearance exactly what pdf.js drew in the editor.
// pdf.js skips Hidden/NoView/optional-content widgets and draws the /AS state; pdf-lib's flatten would draw them all,
// pick button states by the field /V, and regenerate missing appearances from /V.
function pinShownAppearances(doc: PDFDocument, form: PDFForm) {
  const empty = doc.context.register(doc.context.formXObject([], { BBox: [0, 0, 0, 0] }));
  for (const field of form.getFields()) {
    const button = field instanceof PDFCheckBox || field instanceof PDFRadioGroup;
    for (const w of field.acroField.getWidgets()) {
      const n = w.dict.lookupMaybe(PDFName.of('AP'), PDFDict)?.get(PDFName.of('N'));
      const nd = n && doc.context.lookup(n);
      let shown = nd instanceof PDFDict ? nd.get(w.getAppearanceState() ?? PDFName.of('Off')) : n;
      if (w.hasFlag(2) || w.hasFlag(32) || w.dict.has(PDFName.of('OC')) || !(shown instanceof PDFRef)) shown = empty;
      w.dict.set(PDFName.of('AP'), doc.context.obj({ N: button ? { Off: shown } : shown }));
    }
  }
}

// The output is a flat signed document: no auto-run, page/annotation actions, scripts, launches or form submission.
function stripActiveContent(doc: PDFDocument) {
  const [A, AA, S] = ['A', 'AA', 'S'].map((k) => PDFName.of(k));
  doc.catalog.delete(PDFName.of('OpenAction'));
  doc.catalog.delete(AA);
  doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.delete(PDFName.of('JavaScript'));
  for (const page of doc.getPages()) {
    page.node.delete(AA);
    const annots = page.node.Annots();
    for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) {
      const annot = annots!.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      annot.delete(AA);
      const action = annot.lookupMaybe(A, PDFDict);
      if (/^\/(JavaScript|Launch|SubmitForm|ImportData)$/.test(String(action?.get(S)))) annots!.remove(i);
      else action?.delete(PDFName.of('Next')); // chained actions could be any of the above
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
