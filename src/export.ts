import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage } from '@cantoo/pdf-lib';
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
  const doc = await PDFDocument.load(originalBytes, { password });
  // Bake form fields into the page so our text isn't hidden under widgets and fields aren't left live.
  try {
    doc.getForm().flatten();
  } catch {}
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
  return doc.save();
}
