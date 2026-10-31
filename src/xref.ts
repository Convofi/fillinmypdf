import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFObjectParser, PDFRawStream, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';

// pdf.js finds objects through the xref chain (newest section first); pdf-lib parses the file front to back and the
// last definition of an object number wins. A file can therefore define an object twice so that each library sees a
// different page. Rebuild the input so pdf-lib can only see the objects pdf.js uses: blank every definition the xref
// doesn't point at, and refuse anything we can't make consistent.

type Entry = { type: 0 } | { type: 1; offset: number; gen: number } | { type: 2; stream: number; index: number };

export class InconsistentFile extends Error {}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const num = (o: unknown) => (o instanceof PDFNumber ? o.asNumber() : undefined);

export function xrefConsistentBytes(input: Uint8Array): { bytes: Uint8Array; root: string; blanked: number; headers: number } {
  const text = latin1(input);
  const ctx = PDFContext.create();
  const fail = (why: string): never => {
    throw new InconsistentFile(why);
  };
  const parseAt = (offset: number) => PDFObjectParser.forBytes(input.subarray(offset), ctx).parseObject();

  // 1. Walk the xref chain from the last startxref: /XRefStm then /Prev, newest first; first mention wins.
  const sx = text.lastIndexOf('startxref');
  const start = sx < 0 ? NaN : Number(/^startxref\s+(\d+)/.exec(text.slice(sx, sx + 40))?.[1]);
  if (!Number.isFinite(start)) fail('no startxref');
  const live = new Map<number, Entry>();
  const set = (n: number, e: Entry) => live.has(n) || live.set(n, e);
  const queue = [start];
  const seen = new Set<number>();
  let root = '';
  while (queue.length) {
    const at = queue.shift()!;
    if (seen.has(at) || at < 0 || at >= input.length || seen.size > 1000) fail('bad xref chain');
    seen.add(at);
    let trailer: PDFDict;
    const head = /^\s*xref\b/y;
    if (head.test(text.slice(at, at + 32))) {
      // Classic table: "start count" subsection headers, 20-byte entries, then "trailer << ... >>".
      let pos = at + text.slice(at).indexOf('xref') + 4;
      const sub = /\s*(\d+)\s+(\d+)\s+(?=\d)/y;
      const ent = /(\d{1,10})\s+(\d{1,5})\s+([nf])[ \r\n]*/y;
      for (;;) {
        sub.lastIndex = pos;
        const h = sub.exec(text);
        if (!h) break;
        pos = sub.lastIndex;
        for (let i = 0, first = +h[1]; i < +h[2]; i++) {
          ent.lastIndex = pos;
          const e = ent.exec(text);
          if (!e) fail('bad xref entry');
          pos = ent.lastIndex;
          set(first + i, e![3] === 'n' ? { type: 1, offset: +e![1], gen: +e![2] } : { type: 0 });
        }
      }
      const t = /\s*trailer\s*/y;
      t.lastIndex = pos;
      if (!t.exec(text)) fail('no trailer');
      const d = parseAt(t.lastIndex);
      trailer = d instanceof PDFDict ? d : fail('bad trailer');
    } else {
      // Cross-reference stream: "N G obj << /Type /XRef /W [..] /Index [..] >> stream ... endstream".
      const h = /^\s*\d+\s+\d+\s+obj\b/.exec(text.slice(at, at + 64));
      const s = h ? parseAt(at + h[0].length) : undefined;
      if (!(s instanceof PDFRawStream) || s.dict.get(PDFName.of('Type')) !== PDFName.of('XRef')) fail('bad xref stream');
      const stream = s as PDFRawStream;
      trailer = stream.dict;
      const w = (stream.dict.lookup(PDFName.of('W')) as PDFArray).asArray().map((x) => num(x) ?? 0);
      const size = num(stream.dict.get(PDFName.of('Size'))) ?? 0;
      const index = (stream.dict.lookupMaybe(PDFName.of('Index'), PDFArray)?.asArray().map((x) => num(x) ?? 0)) ?? [0, size];
      const data = decodePDFRawStream(stream).decode();
      const field = (p: number, n: number) => {
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 256 + data[p + i];
        return v;
      };
      let p = 0;
      for (let k = 0; k + 1 < index.length; k += 2)
        for (let i = 0; i < index[k + 1]; i++) {
          if (p + w[0] + w[1] + w[2] > data.length) fail('short xref stream');
          const type = w[0] ? field(p, w[0]) : 1;
          const f2 = field(p + w[0], w[1]);
          const f3 = field(p + w[0] + w[1], w[2]);
          p += w[0] + w[1] + w[2];
          set(index[k] + i, type === 1 ? { type: 1, offset: f2, gen: f3 } : type === 2 ? { type: 2, stream: f2, index: f3 } : { type: 0 });
        }
    }
    if (!root) root = String(trailer.get(PDFName.of('Root')) ?? '');
    const xs = num(trailer.get(PDFName.of('XRefStm')));
    const prev = num(trailer.get(PDFName.of('Prev')));
    if (xs !== undefined) queue.push(xs);
    if (prev !== undefined) queue.push(prev);
  }
  if (!root) fail('no /Root');

  // 2. Every live offset must point at that object's header, or pdf.js rebuilds the table by scanning.
  for (const [n, e] of live) {
    if (e.type !== 1 || n === 0) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+obj\b/.exec(text.slice(e.offset, e.offset + 48));
    if (!m || +m[1] !== n || +m[2] !== e.gen) fail(`xref offset of ${n} does not point at it`);
  }

  // 3. Blank every raw "N G obj ... endobj" that isn't the live one (keeping older revisions of the same generation,
  // which pdf-lib's last-definition-wins already overrides). A match inside a stream at worst blanks real data,
  // which changes the rendering and is then refused by the render check - never a silent leak.
  const out = input.slice();
  const header = /(?<![\w.])(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj(?![\w])/g;
  const streams = new Map<number, number>(); // live object streams: number -> offset
  let blanked = 0;
  let headers = 0;
  for (let m; (m = header.exec(text)); ) {
    headers++;
    const [n, g, at] = [+m[1], +m[2], m.index];
    const end = text.indexOf('endobj', at);
    const stop = end < 0 ? text.length : end + 6;
    header.lastIndex = stop;
    const e = live.get(n);
    if ([...seen].some((x) => x <= at && at - x < 16 && /^\s*$/.test(text.slice(x, at)))) continue; // an xref stream we walked
    if (e?.type === 1 && e.gen === g && /^\s*$/.test(text.slice(e.offset, at))) {
      if (/\/Type\s*\/ObjStm\b/.test(text.slice(at, Math.min(stop, at + 2048)))) streams.set(n, at);
      continue;
    }
    if (e?.type === 1 && e.gen === g && at < e.offset) continue; // older revision, overridden later in the file
    out.fill(0x20, at, stop);
    blanked++;
  }

  // 4. Object streams pdf-lib will unpack (in file order, overriding earlier definitions) must agree with the xref.
  for (const [s, at] of streams) {
    const h = /^\s*\d+\s+\d+\s+obj\b/.exec(text.slice(at, at + 64))!;
    const obj = parseAt(at + h[0].length);
    if (!(obj instanceof PDFRawStream)) fail('bad object stream');
    const stream = obj as PDFRawStream;
    const count = num(stream.dict.get(PDFName.of('N'))) ?? 0;
    const pairs = latin1(decodePDFRawStream(stream).decode()).trim().split(/\s+/, count * 2).map(Number);
    const firstSeen = new Set<number>();
    for (let i = 0; i < count; i++) {
      const n = pairs[2 * i];
      const e = live.get(n);
      const dup = firstSeen.has(n);
      firstSeen.add(n);
      if (e?.type === 2 && e.stream === s && e.index === i && !dup) continue;
      if (e?.type === 1 && e.offset > at) continue; // a later definition overrides this copy in pdf-lib too
      if (e?.type === 2 && e.stream !== s && (streams.get(e.stream) ?? -1) > at) continue; // its live stream comes later
      fail(`object ${n} in object stream ${s} disagrees with the xref`);
    }
  }
  return { bytes: out, root, blanked, headers };
}

export const refString = (r: unknown) => (r instanceof PDFRef ? String(r) : '');
