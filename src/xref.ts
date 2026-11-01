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

// dead: an in-use entry whose offset isn't a header (pdf.js throws on fetching it); off: pdf.js's fetch at the exact
// xref offset fails (we found the header only by resyncing a few bytes).
type Entry = { type: 0; dead?: true } | { type: 1; offset: number; gen: number; off?: true } | { type: 2; stream: number; index: number };
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
// pdf.js reads a stream's /F and /DP before /Filter and /DecodeParms (Parser.filter, pdf.worker.mjs 11619-11620), and
// leaves a stream whose filters include /Crypt undecrypted (#hasCryptFilter, 11527; makeStream, 11610-11611). We decode by
// /Filter and decrypt every stream, so refuse stream dicts with /F, /DP or a /Crypt filter (an indirect filter name in
// an xref stream, where we can't resolve it, too).
function plainFilters(dict: PDFDict, resolve: (o: PDFObject | undefined) => PDFObject | undefined = (o) => o) {
  if (dict.has(PDFName.of('F')) || dict.has(PDFName.of('DP'))) fail('stream with /F or /DP');
  const f = resolve(dict.get(PDFName.of('Filter')));
  const names = f instanceof PDFArray ? f.asArray().map(resolve) : [f];
  if (names.some((n) => n === PDFName.of('Crypt') || n instanceof PDFRef)) fail('stream with a /Crypt filter');
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
      plainFilters(stream.dict);
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

  // Every live offset must point at that object's header (resynced within ±8 bytes). One that doesn't (Quartz writes
  // in-use entries with offset 0 for objects that don't exist) is dead: pdf.js's fetchUncompressed throws
  // XRefEntryException("Bad (uncompressed) XRef entry") for it, so unreferenced it is inert; if something does fetch
  // it, pdf.js shows an error or re-indexes the file, and the render/text checks compare against exactly that.
  for (const [n, e] of live) {
    if (e.type !== 1 || n === 0) continue;
    const at = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8].map((d) => e.offset + d).find((p) => {
      const m = p >= 0 && header(text, p);
      return m && +m[1] === n && +m[2] === e.gen;
    });
    const exact = header(text, e.offset);
    if (!exact || +exact[1] !== n || +exact[2] !== e.gen) e.off = true;
    if (at === undefined) live.set(n, e.offset ? { type: 0, dead: true } : { type: 0 });
    else e.offset = at;
  }
  return { live, trailer: newest!, sections, sectionObjects };
}

// Where an object's stream data ends, the way pdf.js reads it: /Length (direct, or an indirect integer through the
// live xref) when it lands on "endstream", else the first "endstream". Without this an "endobj" inside the data would
// end the object early. Returns the position to search for "endobj" from.
function streamEnd(text: string, from: number, live: Map<number, Entry>): number {
  const dictEnd = text.indexOf('endobj', from);
  const kw = /(?:>>|[\0\t\n\f\r ])stream(?:\r\n|\r|\n)/g;
  kw.lastIndex = from;
  const s = kw.exec(text);
  if (!s || (dictEnd >= 0 && s.index > dictEnd)) return from;
  const data = s.index + s[0].length;
  const dict = text.slice(from, s.index);
  const len = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict);
  let length = len && !len[2] ? +len[1] : NaN;
  if (len?.[2]) {
    const e = live.get(+len[1]);
    if (e?.type === 1) length = Number(new RegExp(`^${GAP.replace('+', '*')}\\d+${GAP}\\d+${GAP}obj${GAP}(\\d+)`).exec(text.slice(e.offset, e.offset + 64))?.[1] ?? NaN);
  }
  if (Number.isFinite(length) && /^[\0\t\n\f\r ]*endstream/.test(text.slice(data + length, data + length + 40))) return data + length;
  const es = text.indexOf('endstream', data);
  return es < 0 ? data : es;
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
    const end = text.indexOf('endobj', streamEnd(text, at + m[0].length, xref.live));
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

  // (a) No object pdf.js wouldn't resolve: anything not in the live xref (a stale object stream's freed members, a
  // definition the scanner missed) doesn't exist for pdf.js, so it mustn't exist for pdf-lib either.
  let replaced = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    const e = live.get(ref.objectNumber);
    const ok = (e?.type === 1 && e.gen === ref.generationNumber) || (e?.type === 2 && ref.generationNumber === 0) || xref.sectionObjects.has(ref.objectNumber);
    if (!ok) ctx.delete(ref), replaced++;
  }

  // Every live object as pdf.js resolves it, fetched on demand like XRef.fetch: type 1 parsed at its offset with the
  // cipher (pdfjsObject cuts stream data the way pdf.js does), type 2 from its decoded object stream.
  const text = latin1(original);
  const liveObjects = new Map<number, PDFObject>();
  const rawData = new Map<number, Uint8Array>(); // stream data as pdf.js cuts it, before decryption
  const decoded = new Map<number, Map<number, PDFObject>>(); // object stream -> object number -> object
  const pending = new Set<number>();
  const lengthOf = (dict: PDFDict) => {
    const l = dict.get(PDFName.of('Length'));
    if (!(l instanceof PDFRef)) return num(l);
    const e = live.get(l.objectNumber);
    if (!e || e.type === 0) return undefined; // pdf.js: null (a dead entry is refused in (c))
    if (e.type === 1 && e.gen !== l.generationNumber) fail(`/Length ${l} has the wrong generation`);
    return num(fetch(l.objectNumber));
  };
  const objectStream = (s: number) => {
    const known = decoded.get(s);
    if (known) return known;
    const stream = live.get(s)?.type === 1 ? fetch(s) : undefined;
    if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of('Type')) !== PDFName.of('ObjStm')) fail(`object stream ${s} is missing`);
    const { dict } = stream as PDFRawStream;
    const data = decodeStream(stream as PDFRawStream);
    const count = num(dict.get(PDFName.of('N'))) ?? 0;
    const first = num(dict.get(PDFName.of('First'))) ?? 0;
    const pairs = latin1(data.subarray(0, first)).trim().split(/\s+/, count * 2).map(Number);
    // Older revisions' object streams may still list superseded objects: only the live (number, index) pairs count.
    const objects = new Map<number, PDFObject>();
    for (let i = 0; i < count; i++) {
      const n = pairs[2 * i];
      const e = live.get(n);
      if (e?.type === 2 && e.stream === s && e.index === i)
        objects.set(n, PDFObjectParser.forBytes(data.subarray(first + pairs[2 * i + 1]), ctx).parseObject(PDFRef.of(n, 0)));
    }
    decoded.set(s, objects);
    return objects;
  };
  const fetch = (n: number): PDFObject => {
    const known = liveObjects.get(n);
    if (known) return known;
    const e = live.get(n);
    if (!e || e.type === 0 || pending.has(n)) fail(`object ${n} is not resolvable`);
    pending.add(n);
    let obj: PDFObject;
    if (e!.type === 1) {
      const got = pdfjsObject(original, text, e!.offset, PDFRef.of(n, e!.gen), ctx, cipher, lengthOf);
      if (got.raw) rawData.set(n, got.raw);
      obj = got.obj;
      if (obj instanceof PDFRawStream) plainFilters(obj.dict, (o) => (o instanceof PDFRef && live.has(o.objectNumber) ? fetch(o.objectNumber) : o));
      const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
      const type = dict?.get(PDFName.of('Type'));
      if (type !== undefined && !(type instanceof PDFName)) fail(`object ${n} has an indirect /Type`);
    } else {
      const { stream } = e as { stream: number };
      obj = objectStream(stream).get(n) ?? fail(`object ${n} is not at its index in object stream ${stream}`);
    }
    pending.delete(n);
    liveObjects.set(n, obj);
    return obj;
  };
  for (const [n] of live) if (n !== 0 && !xref.sectionObjects.has(n) && live.get(n)!.type !== 0) fetch(n);

  // (c) A ref pdf.js can't fetch (dead entry, offset off its header, other generation) throws XRefEntryException
  // (fetchUncompressed, pdf.worker.mjs 58683-58713). While pdf.js checks the page tree (checkFirstPage/checkLastPage,
  // 60006-60055) that becomes XRefParseException and recovery mode (XRef.indexObjects, 58330): the whole file is
  // re-indexed with later definitions winning - a document different from the xref's. Refuse any such ref reachable
  // from the trailer (unreferenced dead entries, like Quartz's offset-0 ones, are inert).
  const seen = new Set<number>();
  const todo: (PDFObject | undefined)[] = [xref.trailer];
  while (todo.length) {
    const o = todo.pop();
    if (o instanceof PDFRef) {
      const e = live.get(o.objectNumber);
      if ((e?.type === 0 && e.dead) || (e?.type === 1 && (e.off || e.gen !== o.generationNumber))) fail(`${o} can't be fetched`);
      if (!seen.has(o.objectNumber)) seen.add(o.objectNumber), todo.push(liveObjects.get(o.objectNumber));
    } else if (o instanceof PDFDict) for (const v of o.values()) todo.push(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) todo.push(v);
    else if (o instanceof PDFRawStream) todo.push(o.dict);
  }

  // (b) Every live object pdf-lib holds must equal the live definition; replace the ones that don't.
  for (const [n, obj] of liveObjects) {
    const e = live.get(n)!;
    const ref = PDFRef.of(n, e.type === 1 ? e.gen : 0);
    const held = ctx.lookup(ref);
    // Encrypted streams are compared raw too: pdf-lib's data at that offset before decryption.
    const raw = cipher && rawData.get(n);
    let heldRaw: Uint8Array | undefined;
    if (raw && e.type === 1) try { heldRaw = (parseAt(bytes, e.offset) as PDFRawStream).contents; } catch { /* pdf-lib can't read it: differs */ }
    if (held === undefined || held.toString() !== obj.toString() || (raw && !same(heldRaw, raw))) {
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

// Parse the object whose "N G obj" header is at `at` the way pdf.js does, decrypting like pdf-lib for that ref.
// Stream data (Parser.makeStream, pdf.worker.mjs 11585-11610): skip to the next line after the "stream" token
// (Lexer.skipToNextLine, 12078); take /Length bytes if an integer /Length (indirect: fetched) is followed by an
// "endstream" token, else up to the first "endstream" (#findStreamLength, 11530-11584, which also accepts
// "endsteam"/"endstrea" + whitespace). pdf-lib differs for an indirect /Length: it runs to the first "endstream" not
// balanced by an earlier "stream" word in the data. `raw` is the data before decryption.
const SPECIAL = new Set([0, 9, 10, 12, 13, 32, ...[...'%()/<>[]{}'].map((c) => c.charCodeAt(0))]);
function pdfjsObject(
  bytes: Uint8Array, text: string, at: number, ref: PDFRef, ctx: PDFContext, cipher: CipherTransformFactory | undefined, lengthOf: (d: PDFDict) => number | undefined,
): { obj: PDFObject; raw?: Uint8Array } {
  const h = header(text, at) ?? fail(`no object at ${at}`);
  const base = at + h[0].length;
  const p = PDFObjectParser.forBytes(bytes.subarray(base), ctx) as unknown as {
    parseObject(ref: PDFRef): PDFObject; parseDict(ref: PDFRef): PDFDict; skipWhitespaceAndComments(): void; bytes: { offset(): number }; cryptoFactory?: CipherTransformFactory;
  };
  p.cryptoFactory = cipher;
  p.skipWhitespaceAndComments();
  if (!text.startsWith('<<', base + p.bytes.offset())) return { obj: p.parseObject(ref) };
  const dict = p.parseDict(ref);
  p.skipWhitespaceAndComments();
  const kw = base + p.bytes.offset();
  if (!text.startsWith('stream', kw)) return { obj: dict };
  if (kw + 6 < bytes.length && !SPECIAL.has(bytes[kw + 6])) fail(`object ${ref} has a stream keyword pdf.js does not read`);
  let start = kw + 6;
  while (start < bytes.length && bytes[start] !== 13 && bytes[start] !== 10) start++;
  start += bytes[start] === 13 && bytes[start + 1] === 10 ? 2 : 1;
  let end = -1;
  const length = lengthOf(dict);
  if (length !== undefined && Number.isInteger(length) && length >= 0) {
    // The next token after the data, skipping whitespace and comments like pdf.js's Lexer.getObj.
    const t = new RegExp(String.raw`(?:[\0\t\n\f\r ]|%[^\r\n]*(?![^\r\n]))*endstream`, 'y');
    t.lastIndex = start + length;
    if (t.test(text) && (t.lastIndex >= bytes.length || SPECIAL.has(bytes[t.lastIndex]))) end = start + length;
  }
  if (end < 0) {
    const es = /end(?:stream|steam[\t\n\r ]|strea[\t\n\r ])/g;
    es.lastIndex = start;
    const m = es.exec(text);
    if (!m || m.index + 9 >= bytes.length) fail(`object ${ref} has no endstream`);
    end = m!.index;
  }
  const raw = bytes.slice(start, end);
  return { obj: PDFRawStream.of(dict, cipher ? cipher.createCipherTransform(ref.objectNumber, ref.generationNumber).decryptBytes(raw) : raw), raw };
}

const same = (a: Uint8Array | undefined, b: Uint8Array) => a?.length === b.length && a.every((x, i) => x === b[i]);
const parseAt = (bytes: Uint8Array, at: number) => {
  const h = header(latin1(bytes.subarray(at, at + 512)), 0);
  return h ? PDFObjectParser.forBytes(bytes.subarray(at + h[0].length), PDFContext.create()).parseObject() : undefined;
};
