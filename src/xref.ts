import {
  PDFArray, PDFContext, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFObjectParser, PDFRawStream, PDFRef,
  PDFString, decodePDFRawStream, type PDFObject,
} from '@cantoo/pdf-lib';
import { CipherTransformFactory } from 'pdf-lib-crypto';

// pdf.js finds objects through the xref chain (newest section first); pdf-lib parses the file front to back and the
// last definition of an object number wins. A file can therefore define an object twice so that each library sees a
// different document. Two layers make pdf-lib see exactly the objects pdf.js uses:
//  1. before parsing: blank every raw definition the xref doesn't point at (xrefConsistentBytes);
//  2. after parsing: every object pdf-lib holds must be a live xref object, and equal to that object parsed at its
//     xref location; differing ones are replaced (loadAsPdfJsSees). Anything we can't make consistent is refused.

type Entry = { type: 0 } | { type: 1; offset: number; gen: number } | { type: 2; stream: number; index: number };
type Xref = { live: Map<number, Entry>; trailer: PDFDict; sections: Set<number>; sectionObjects: Set<number> };

export class InconsistentFile extends Error {}
const fail = (why: string): never => {
  throw new InconsistentFile(why);
};

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const num = (o: unknown) => (o instanceof PDFNumber ? o.asNumber() : undefined);
// PDF whitespace and comments, as pdf-lib's tokenizer skips them between "N G obj" tokens.
// A comment always runs to the end of its line (no backtracking into it, or "%%EOF8 0 obj" would read as a header).
const GAP = String.raw`(?:[\0\t\n\f\r ]|%[^\r\n]*[\r\n])+`;
const HEADER_AT = new RegExp(String.raw`^${GAP.replace('+', '*')}(\d+)${GAP}(\d+)${GAP}obj(?![\w])`);
const header = (text: string, at: number) => HEADER_AT.exec(text.slice(at, at + 512));

// pdf-lib decodes the filter but not /DecodeParms /Predictor, which xref streams almost always use (PNG Up = 12).
function unpredict(data: Uint8Array, parms: PDFDict | undefined): Uint8Array {
  const p = (k: string, d: number) => num(parms?.get(PDFName.of(k))) ?? d;
  const predictor = p('Predictor', 1);
  if (predictor < 2) return data;
  const colors = p('Colors', 1), bpc = p('BitsPerComponent', 8), columns = p('Columns', 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const row = Math.ceil((columns * colors * bpc) / 8);
  if (predictor === 2) {
    // TIFF: horizontal differencing, byte-wise (8-bit components).
    const out = data.slice();
    for (let r = 0; r + row <= out.length; r += row) for (let i = bpp; i < row; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  // PNG (10-15): every row starts with its own filter type byte.
  const rows = Math.floor(data.length / (row + 1));
  const out = new Uint8Array(rows * row);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (row + 1)];
    const src = r * (row + 1) + 1, dst = r * row;
    for (let i = 0; i < row; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[dst - row + i] : 0;
      const c = r > 0 && i >= bpp ? out[dst - row + i - bpp] : 0;
      let v = x;
      if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}
const decodeStream = (s: PDFRawStream) => {
  const p = s.dict.lookup(PDFName.of('DecodeParms'));
  return unpredict(decodePDFRawStream(s).decode(), p instanceof PDFDict ? p : p instanceof PDFArray ? p.lookupMaybe(0, PDFDict) : undefined);
};

// Walk the xref chain from the last startxref: /XRefStm then /Prev, newest first; the first mention of an object wins.
function readXref(input: Uint8Array, text: string): Xref {
  const ctx = PDFContext.create();
  const sx = text.lastIndexOf('startxref');
  const start = sx < 0 ? NaN : Number(/^startxref\s+(\d+)/.exec(text.slice(sx, sx + 40))?.[1]);
  if (!Number.isFinite(start)) fail('no startxref');
  const live = new Map<number, Entry>();
  const set = (n: number, e: Entry) => live.has(n) || live.set(n, e);
  const queue = [start];
  const sections = new Set<number>();
  const sectionObjects = new Set<number>();
  let newest: PDFDict | undefined;
  while (queue.length) {
    let at = queue.shift()!;
    if (sections.has(at) || at < 0 || at >= input.length || sections.size > 1000) fail('bad xref chain');
    // Writers are sometimes a few bytes off; pdf.js tolerates it, so look within ±8 bytes.
    const near = (re: RegExp) => [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8].map((d) => at + d).find((p) => p >= 0 && re.test(text.slice(p, p + 64)));
    at = near(/^xref\b/) ?? near(new RegExp(`^\\d+${GAP}\\d+${GAP}obj`)) ?? fail('no xref section at startxref');
    sections.add(at);
    let trailer: PDFDict;
    if (text.startsWith('xref', at)) {
      // Classic table: "first count" + EOL, then 20-byte entries; empty subsections ("0 0") are fine.
      let pos = at + 4;
      const sub = /\s*(\d+)[ \t]+(\d+)[ \t]*(?:\r\n|\r|\n)/y;
      const ent = /\s*(\d{1,10})[ \t]+(\d{1,5})[ \t]+([nf])/y;
      for (;;) {
        sub.lastIndex = pos;
        const h = sub.exec(text);
        if (!h) break;
        pos = sub.lastIndex;
        for (let i = 0, first = +h[1]; i < +h[2]; i++) {
          ent.lastIndex = pos;
          const e = ent.exec(text) ?? fail('bad xref entry');
          pos = ent.lastIndex;
          set(first + i, e[3] === 'n' ? { type: 1, offset: +e[1], gen: +e[2] } : { type: 0 });
        }
      }
      const t = /\s*trailer\s*/y;
      t.lastIndex = pos;
      if (!t.exec(text)) fail('no trailer');
      const d = PDFObjectParser.forBytes(input.subarray(t.lastIndex), ctx).parseObject();
      trailer = d instanceof PDFDict ? d : fail('bad trailer');
    } else {
      // Cross-reference stream: "N G obj << /Type /XRef /W [..] /Index [..] >> stream ... endstream".
      const h = header(text, at)!;
      sectionObjects.add(+h[1]);
      const s = PDFObjectParser.forBytes(input.subarray(at + h[0].length), ctx).parseObject();
      if (!(s instanceof PDFRawStream) || s.dict.get(PDFName.of('Type')) !== PDFName.of('XRef')) fail('bad xref stream');
      const stream = s as PDFRawStream;
      trailer = stream.dict;
      const w = (stream.dict.lookup(PDFName.of('W'), PDFArray) as PDFArray).asArray().map((x) => num(x) ?? 0);
      const size = num(stream.dict.get(PDFName.of('Size'))) ?? 0;
      const index = stream.dict.lookupMaybe(PDFName.of('Index'), PDFArray)?.asArray().map((x) => num(x) ?? 0) ?? [0, size];
      const data = decodeStream(stream);
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
    newest ??= trailer;
    const xs = num(trailer.get(PDFName.of('XRefStm')));
    const prev = num(trailer.get(PDFName.of('Prev')));
    if (xs !== undefined) queue.push(xs);
    if (prev !== undefined) queue.push(prev);
  }
  if (!(newest!.get(PDFName.of('Root')) instanceof PDFRef)) fail('no /Root');

  // Every live offset must point at that object's header (resynced within ±8 bytes), or pdf.js rebuilds the table
  // by scanning and we can't know what it chose.
  for (const [n, e] of live) {
    if (e.type !== 1 || n === 0) continue;
    const at = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8].map((d) => e.offset + d).find((p) => {
      const m = p >= 0 && header(text, p);
      return m && +m[1] === n && +m[2] === e.gen;
    });
    if (at === undefined) fail(`xref offset of ${n} does not point at it`);
    e.offset = at!;
  }
  return { live, trailer: newest!, sections, sectionObjects };
}

// Layer 1: blank every raw "N G obj ... endobj" that isn't the live one (keeping older revisions of the same
// generation, which pdf-lib's last-definition-wins already overrides). A match inside a stream at worst blanks real
// data, which changes the rendering and is refused by the render check - never a silent leak.
export function xrefConsistentBytes(input: Uint8Array): { bytes: Uint8Array; xref: Xref; blanked: number; headers: number } {
  const text = latin1(input);
  const xref = readXref(input, text);
  const out = input.slice();
  const re = new RegExp(String.raw`(?<![\w.])(\d+)${GAP}(\d+)${GAP}obj(?![\w])`, 'g');
  let blanked = 0;
  let headers = 0;
  for (let m; (m = re.exec(text)); ) {
    headers++;
    const [n, g, at] = [+m[1], +m[2], m.index];
    const end = text.indexOf('endobj', at);
    const stop = end < 0 ? text.length : end + 6;
    re.lastIndex = stop;
    const e = xref.live.get(n);
    if ([...xref.sections].some((x) => Math.abs(x - at) <= 8)) continue; // an xref stream we walked
    if (e?.type === 1 && e.gen === g && (e.offset === at || /^[\0\t\n\f\r ]*$/.test(text.slice(Math.min(at, e.offset), Math.max(at, e.offset))))) continue;
    if (e?.type === 1 && e.gen === g && at < e.offset) continue; // older revision, overridden later in the file
    out.fill(0x20, at, stop);
    blanked++;
  }
  return { bytes: out, xref, blanked, headers };
}

// Layer 2: load with pdf-lib, then make its object table equal pdf.js's view. Returns the document and how many
// objects had to be replaced (0 on every clean file we know).
export async function loadAsPdfJsSees(original: Uint8Array, password: string): Promise<{ doc: PDFDocument; replaced: number }> {
  const { bytes, xref } = xrefConsistentBytes(original);
  let doc = await PDFDocument.load(bytes, { password, preserveXFA: true, updateMetadata: false });
  const ctx = doc.context;
  const { live } = xref;

  // pdf-lib decrypts strings and streams per object; parse live objects with the same cipher.
  const encrypt = xref.trailer.get(PDFName.of('Encrypt'));
  let cipher: CipherTransformFactory | undefined;
  if (encrypt instanceof PDFRef) {
    const e = live.get(encrypt.objectNumber);
    const encDict = e?.type === 1 ? parseAt(bytes, e.offset) : undefined;
    const id = xref.trailer.lookup(PDFName.of('ID'));
    const first = id instanceof PDFArray ? id.get(0) : undefined;
    if (!(encDict instanceof PDFDict) || !(first instanceof PDFString || first instanceof PDFHexString)) fail('unreadable encryption');
    cipher = new CipherTransformFactory(encDict as PDFDict, (first as PDFString).asBytes(), password);
  }
  // Parse the object whose "N G obj" header is at `at`, decrypting like pdf-lib does for that ref.
  const parse = (at: number, ref: PDFRef) => {
    const h = header(latin1(bytes.subarray(at, at + 512)), 0) ?? fail(`no object at ${at}`);
    const parser = PDFObjectParser.forBytes(bytes.subarray(at + h[0].length), ctx);
    if (cipher) (parser as unknown as { cryptoFactory: CipherTransformFactory }).cryptoFactory = cipher;
    return parser.parseObject(ref);
  };

  // (a) No object pdf.js wouldn't resolve: anything not in the live xref (a stale object stream's freed members, a
  // definition the scanner missed) doesn't exist for pdf.js, so it mustn't exist for pdf-lib either.
  let replaced = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    const e = live.get(ref.objectNumber);
    const ok = (e?.type === 1 && e.gen === ref.generationNumber) || (e?.type === 2 && ref.generationNumber === 0) || xref.sectionObjects.has(ref.objectNumber);
    if (!ok) ctx.delete(ref), replaced++;
  }

  // Object streams, identified by their parsed /Type (a /Type that isn't a direct name is refused).
  const streams = new Map<number, PDFRawStream>();
  const liveObjects = new Map<number, PDFObject>();
  for (const [n, e] of live) {
    if (e.type !== 1 || n === 0 || xref.sectionObjects.has(n)) continue;
    const obj = parse(e.offset, PDFRef.of(n, e.gen));
    liveObjects.set(n, obj);
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    const type = dict?.get(PDFName.of('Type'));
    if (type !== undefined && !(type instanceof PDFName)) fail(`object ${n} has an indirect /Type`);
    if (type === PDFName.of('ObjStm')) streams.set(n, obj as PDFRawStream);
  }
  const members = new Map<number, number>(); // type-2 objects -> container
  for (const [n, e] of live) if (e.type === 2) members.set(n, e.stream);
  for (const s of new Set(members.values())) if (!streams.has(s)) fail(`object stream ${s} is missing`);
  for (const [s, stream] of streams) {
    const data = decodeStream(stream);
    const count = num(stream.dict.get(PDFName.of('N'))) ?? 0;
    const first = num(stream.dict.get(PDFName.of('First'))) ?? 0;
    const pairs = latin1(data.subarray(0, first)).trim().split(/\s+/, count * 2).map(Number);
    // Older revisions' object streams may still list superseded objects: only the live (number, index) pairs count.
    for (let i = 0; i < count; i++) {
      const n = pairs[2 * i];
      const e = live.get(n);
      if (e?.type === 2 && e.stream === s && e.index === i)
        liveObjects.set(n, PDFObjectParser.forBytes(data.subarray(first + pairs[2 * i + 1]), ctx).parseObject(PDFRef.of(n, 0)));
    }
  }
  for (const [n, s] of members) if (!liveObjects.has(n)) fail(`object ${n} is not at its index in object stream ${s}`);

  // (b) Every live object pdf-lib holds must equal the live definition; replace the ones that don't.
  for (const [n, obj] of liveObjects) {
    const e = live.get(n)!;
    const ref = PDFRef.of(n, e.type === 1 ? e.gen : 0);
    const held = ctx.lookup(ref);
    if (held === undefined || held.toString() !== obj.toString()) {
      ctx.assign(ref, obj);
      replaced++;
    }
  }
  const root = xref.trailer.get(PDFName.of('Root')) as PDFRef;
  if (ctx.trailerInfo.Root !== root) (ctx.trailerInfo.Root = root), replaced++;
  if (replaced) {
    // pdf-lib's document caches the catalog and page tree: rebuild it from the corrected object table.
    const fixed = await doc.save({ updateFieldAppearances: false, useObjectStreams: false });
    doc = await PDFDocument.load(fixed, { preserveXFA: true });
  }
  return { doc, replaced };
}

const parseAt = (bytes: Uint8Array, at: number) => {
  const h = header(latin1(bytes.subarray(at, at + 512)), 0);
  return h ? PDFObjectParser.forBytes(bytes.subarray(at + h[0].length), PDFContext.create()).parseObject() : undefined;
};
