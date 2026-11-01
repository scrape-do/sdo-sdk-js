// SPDX-License-Identifier: Apache-2.0
// Response text decoding: the WHATWG Encoding Standard "decode" ladder, the same
// in every sdo SDK.
//
//   1. A byte-order mark decides the encoding and is removed (it beats any label).
//   2. The Content-Type charset, resolved through the WHATWG label table.
//   3. */json and */*+json are UTF-8.
//   4. HTML only: <meta charset> / http-equiv in the first 1024 bytes.
//   5. UTF-8.
//
// A label that is unknown or maps to "replacement" is ignored and the ladder
// continues, so a page cannot pick an arbitrary decoder. Invalid sequences
// become U+FFFD per WHATWG "maximal subpart", which TextDecoder implements.
// EUC-KR, Big5 and Shift_JIS use the SDK's own WHATWG decoders (src/cjk.ts),
// because the runtime's are not conformant for them.
import { decodeCjk, isCjkEncoding, loadCjkTables } from "./cjk.js";
import { trimChars } from "./headers.js";

const META_SNIFF_BYTES = 1024;
const HTML_TYPES = new Set(["", "text/html", "application/xhtml+xml"]);
const ASCII_WS = "\t\n\f\r ";

// windows-1252 0x80-0x9F (the rest is Latin-1). Decoded by hand because some
// Node releases decode the latin1 family as ISO-8859-1, and every label in that
// family (iso-8859-1, latin1, us-ascii, ...) means windows-1252 in WHATWG.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d,
  0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d,
  0x17e, 0x178,
];

// Node 22's ICU tables differ from WHATWG at these byte positions (Node 24's
// do not). These single-byte encodings decode through a per-byte table, built
// once from the runtime and corrected here: one code point per byte, as WHATWG
// defines single-byte decoders, so a byte the runtime drops cannot shift the rest.
const SINGLE_BYTE_PATCHES: Readonly<Record<string, ReadonlyMap<number, number>>> = {
  "koi8-u": new Map([
    [0xae, 0x045e],
    [0xbe, 0x040e],
  ]),
  "windows-1255": new Map([[0xca, 0x05ba]]),
  "windows-874": new Map([
    [0xdb, 0xfffd],
    [0xdc, 0xfffd],
    [0xdd, 0xfffd],
    [0xde, 0xfffd],
    [0xfc, 0xfffd],
    [0xfd, 0xfffd],
    [0xfe, 0xfffd],
    [0xff, 0xfffd],
  ]),
};

const singleByteTables = new Map<string, Uint16Array>();

function singleByteTable(encoding: string, patches: ReadonlyMap<number, number>): Uint16Array {
  let table = singleByteTables.get(encoding);
  if (table === undefined) {
    table = new Uint16Array(256);
    const decoder = new TextDecoder(encoding, { ignoreBOM: true });
    for (let b = 0; b < 256; b++) {
      const char = decoder.decode(Uint8Array.of(b));
      table[b] = patches.get(b) ?? (char.length > 0 ? char.charCodeAt(0) : 0xfffd);
    }
    singleByteTables.set(encoding, table);
  }
  return table;
}

function mapBytes(bytes: Uint8Array, map: (b: number) => number): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192), map));
  }
  return out;
}

/** The WHATWG encoding name for a label, or undefined when it is unknown or "replacement". */
export function resolveLabel(label: string): string | undefined {
  const trimmed = trimChars(label, ASCII_WS).toLowerCase();
  if (trimmed === "x-user-defined") return trimmed;
  try {
    // TextDecoder owns the WHATWG label table and throws for unknown and
    // replacement labels alike.
    return new TextDecoder(trimmed).encoding;
  } catch {
    return undefined;
  }
}

function decodeWith(encoding: string, bytes: Uint8Array): string {
  if (encoding === "windows-1252") return mapBytes(bytes, (b) => (b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80]! : b));
  if (encoding === "x-user-defined") return mapBytes(bytes, (b) => (b < 0x80 ? b : 0xf780 + b - 0x80));
  const patches = SINGLE_BYTE_PATCHES[encoding];
  if (patches !== undefined) {
    const table = singleByteTable(encoding, patches);
    return mapBytes(bytes, (b) => table[b]!);
  }
  if (isCjkEncoding(encoding)) {
    const text = decodeCjk(encoding, bytes);
    // Only a result built by hand, before the tables were ever loaded, falls
    // through to the runtime's decoder.
    if (text !== undefined) return text;
  }
  // ignoreBOM: a BOM was already consumed by the sniffing step; a second one is text.
  return new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes);
}

interface ContentType {
  mime: string;
  charset?: string;
}

const HTTP_WS = "\t\n\r ";
// HTTP quoted-string token code points.
const PARAM_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * The essence and the charset parameter of a Content-Type, per the WHATWG MIME
 * Sniffing "parse a MIME type" parameter rules: the first charset wins, only a
 * double-quoted value is unquoted (backslash escapes, an unterminated quote
 * runs to the end), and an unquoted value loses trailing whitespace.
 */
function parseContentType(header: string | undefined): ContentType {
  const value = header ?? "";
  const len = value.length;
  let pos = value.indexOf(";");
  if (pos < 0) pos = len;
  const out: ContentType = { mime: trimChars(value.slice(0, pos), HTTP_WS).toLowerCase() };
  while (pos < len) {
    pos += 1; // the ";"
    while (pos < len && " \t\n\r".includes(value[pos]!)) pos += 1;
    let end = pos;
    while (end < len && value[end] !== ";" && value[end] !== "=") end += 1;
    const name = value.slice(pos, end).toLowerCase();
    pos = end;
    if (pos >= len) break;
    if (value[pos] === ";") continue;
    pos += 1; // the "="
    if (pos >= len) break;
    let param: string;
    if (value[pos] === '"') {
      param = "";
      for (pos += 1; pos < len; pos += 1) {
        const ch = value[pos]!;
        if (ch === '"') break;
        if (ch === "\\" && pos + 1 < len) pos += 1;
        param += value[pos];
      }
      while (pos < len && value[pos] !== ";") pos += 1;
    } else {
      end = pos;
      while (end < len && value[end] !== ";") end += 1;
      param = trimChars(value.slice(pos, end), HTTP_WS, false);
      pos = end;
      if (param === "") continue;
    }
    if (name === "charset" && out.charset === undefined && PARAM_VALUE.test(param)) out.charset = param;
  }
  return out;
}

const SPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const isAlpha = (b: number | undefined): boolean => b !== undefined && ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a));
const lower = (b: number): string => String.fromCharCode(b >= 0x41 && b <= 0x5a ? b + 0x20 : b);

/**
 * The HTML standard's "prescan a byte stream to determine its encoding", over
 * the first 1024 bytes: comments and the attributes of other tags are skipped,
 * and a <meta> counts only when its attributes are complete within the window.
 */
class Prescan {
  pos = 0;
  readonly #b: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#b = bytes.subarray(0, META_SNIFF_BYTES);
  }

  #at(s: string, ci = false): boolean {
    for (let i = 0; i < s.length; i++) {
      const b = this.#b[this.pos + i];
      if (b === undefined || (ci ? lower(b) : String.fromCharCode(b)) !== s[i]) return false;
    }
    return true;
  }

  #find(s: string, from: number): number {
    for (let i = from; i + s.length <= this.#b.length; i++) {
      let hit = true;
      for (let j = 0; hit && j < s.length; j++) hit = this.#b[i + j] === s.charCodeAt(j);
      if (hit) return i;
    }
    return -1;
  }

  /** "Get an attribute": undefined at ">" or when the window ends first (then `pos` is past the end). */
  #attribute(): { name: string; value: string } | undefined {
    const b = this.#b;
    while (SPACE.has(b[this.pos]!) || b[this.pos] === 0x2f) this.pos++;
    if (this.pos >= b.length || b[this.pos] === 0x3e) return undefined;
    let name = "";
    let value = "";
    for (;; this.pos++) {
      const c = b[this.pos];
      if (c === undefined) return undefined;
      if (c === 0x3d && name !== "") break;
      if (SPACE.has(c)) {
        while (SPACE.has(b[this.pos]!)) this.pos++;
        if (b[this.pos] !== 0x3d) return this.pos >= b.length ? undefined : { name, value };
        break;
      }
      if (c === 0x2f || c === 0x3e) return { name, value };
      name += lower(c);
    }
    this.pos++; // the "="
    while (SPACE.has(b[this.pos]!)) this.pos++;
    const quote = b[this.pos];
    if (quote === 0x22 || quote === 0x27) {
      for (this.pos++; ; this.pos++) {
        const c = b[this.pos];
        if (c === undefined) return undefined;
        if (c === quote) {
          this.pos++;
          return { name, value };
        }
        value += lower(c);
      }
    }
    for (;; this.pos++) {
      const c = b[this.pos];
      if (c === undefined) return undefined;
      if (SPACE.has(c) || c === 0x3e) return { name, value };
      value += lower(c);
    }
  }

  /** The encoding a <meta> declares, or undefined; `pos` is left at its end. */
  #meta(): string | undefined {
    const seen = new Set<string>();
    let gotPragma = false;
    let needPragma: boolean | undefined;
    let charset: string | null | undefined; // null = a label that is no encoding
    for (let attr = this.#attribute(); attr !== undefined; attr = this.#attribute()) {
      if (seen.has(attr.name)) continue;
      seen.add(attr.name);
      if (attr.name === "http-equiv") {
        if (attr.value === "content-type") gotPragma = true;
      } else if (attr.name === "content") {
        const label = charsetFromContent(attr.value);
        const encoding = label === undefined ? undefined : resolveLabel(label);
        if (encoding !== undefined && charset === undefined) {
          charset = encoding;
          needPragma = true;
        }
      } else if (attr.name === "charset") {
        charset = resolveLabel(attr.value) ?? null;
        needPragma = false;
      }
    }
    if (this.pos >= this.#b.length || needPragma === undefined || (needPragma && !gotPragma) || !charset) return undefined;
    // A page cannot declare itself UTF-16 from inside its own ASCII-compatible
    // bytes, and x-user-defined means windows-1252 here.
    if (charset === "utf-16le" || charset === "utf-16be") return "utf-8";
    return charset === "x-user-defined" ? "windows-1252" : charset;
  }

  run(): string | undefined {
    const b = this.#b;
    for (; this.pos < b.length; this.pos++) {
      if (this.#at("<!--")) {
        const close = this.#find("-->", this.pos + 4);
        if (close < 0) return undefined;
        this.pos = close + 2;
      } else if (this.#at("<meta", true) && (SPACE.has(b[this.pos + 5]!) || b[this.pos + 5] === 0x2f)) {
        this.pos += 5;
        const found = this.#meta();
        if (found !== undefined) return found;
      } else if (b[this.pos] === 0x3c && (isAlpha(b[this.pos + 1]) || (b[this.pos + 1] === 0x2f && isAlpha(b[this.pos + 2])))) {
        while (this.pos < b.length && !SPACE.has(b[this.pos]!) && b[this.pos] !== 0x3e) this.pos++;
        while (this.#attribute() !== undefined);
      } else if (this.#at("<!") || this.#at("</") || this.#at("<?")) {
        const close = this.#find(">", this.pos + 1);
        if (close < 0) return undefined;
        this.pos = close;
      }
    }
    return undefined;
  }
}

/** The HTML standard's "extracting a character encoding from a meta element" (the label, not yet resolved). */
function charsetFromContent(content: string): string | undefined {
  const s = content.toLowerCase();
  for (let from = 0; ; ) {
    const at = s.indexOf("charset", from);
    if (at < 0) return undefined;
    let i = at + 7;
    while (" \t\n\f\r".includes(s[i] ?? "x")) i++;
    if (s[i] !== "=") {
      from = at + 7;
      continue;
    }
    i++;
    while (" \t\n\f\r".includes(s[i] ?? "x")) i++;
    const q = s[i];
    if (q === undefined) return undefined;
    if (q === '"' || q === "'") {
      const close = s.indexOf(q, i + 1);
      return close < 0 ? undefined : content.slice(i + 1, close);
    }
    let end = i;
    while (end < s.length && !" \t\n\f\r;".includes(s[end]!)) end++;
    return content.slice(i, end);
  }
}

/** The encoding named by the first usable <meta> in the first 1024 bytes (HTML prescan). */
function sniffMeta(bytes: Uint8Array): string | undefined {
  return new Prescan(bytes).run();
}

/** The encoding the ladder picks, and how many BOM bytes to skip. */
export function sniffEncoding(bytes: Uint8Array, contentType?: string): { encoding: string; bomLength: number } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: "utf-8", bomLength: 3 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf-16be", bomLength: 2 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "utf-16le", bomLength: 2 };

  const ct = parseContentType(contentType);
  const labelled = ct.charset === undefined ? undefined : resolveLabel(ct.charset);
  if (labelled !== undefined) return { encoding: labelled, bomLength: 0 };
  if (ct.mime.endsWith("/json") || ct.mime.endsWith("+json")) return { encoding: "utf-8", bomLength: 0 };
  if (HTML_TYPES.has(ct.mime)) {
    const sniffed = sniffMeta(bytes);
    if (sniffed !== undefined) return { encoding: sniffed, bomLength: 0 };
  }
  return { encoding: "utf-8", bomLength: 0 };
}

/** Decode a response body to text with the WHATWG ladder. */
export function decodeText(bytes: Uint8Array, contentType?: string): string {
  const { encoding, bomLength } = sniffEncoding(bytes, contentType);
  return decodeWith(encoding, bytes.subarray(bomLength));
}

/**
 * Load whatever `decodeText` will need for this body. The SDK awaits this before
 * it returns a result, so `.text` stays synchronous.
 */
export async function prepareDecoding(bytes: Uint8Array, contentType?: string): Promise<void> {
  if (isCjkEncoding(sniffEncoding(bytes, contentType).encoding)) await loadCjkTables();
}
