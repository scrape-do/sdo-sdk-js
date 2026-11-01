// SPDX-License-Identifier: Apache-2.0
// WHATWG Encoding Standard decoders for EUC-KR (§14.1.1), Big5 (§12.1.1) and
// Shift_JIS (§13.3.1).
//
// Node's TextDecoder (ICU) is not WHATWG-conformant for these three: it lacks
// the UHC extension of EUC-KR, returns private-use code points for Big5-HKSCS
// pointers and maps Shift_JIS 0x1A to U+001C. These follow the standard's
// algorithms over its own index tables. The tables (about 120 KB) live in a
// separate module that is imported only when a body needs one of them; the SDK
// loads it before it returns such a result.

export type CjkEncoding = "euc-kr" | "big5" | "shift_jis";

type IndexModule = typeof import("./cjk-index.js");

const REPLACEMENT = 0xfffd;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

let index: IndexModule | undefined;
let loading: Promise<void> | undefined;
const tables = new Map<CjkEncoding, Uint32Array>();

export function isCjkEncoding(encoding: string): encoding is CjkEncoding {
  return encoding === "euc-kr" || encoding === "big5" || encoding === "shift_jis";
}

/** Load the index tables (once). Until then, decodeCjk returns undefined. */
export function loadCjkTables(): Promise<void> {
  loading ??= import("./cjk-index.js").then((m) => {
    index = m;
  });
  return loading;
}

/** Expand one table from its compact form (see tools/gen-cjk-index.mjs); 0 = no mapping. */
function expand(data: string, size: number): Uint32Array {
  const digit = new Int8Array(128);
  for (let i = 0; i < ALPHABET.length; i++) digit[ALPHABET.charCodeAt(i)] = i;
  const table = new Uint32Array(size);
  let pos = 0;
  const next = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const d = digit[data.charCodeAt(pos++)]!;
      value += (d & 31) * scale;
      if (d < 32) return value;
      scale *= 32;
    }
  };
  let pointer = -1;
  let codePoint = 0;
  while (pos < data.length) {
    pointer += next() + 1;
    const z = next();
    codePoint += (z % 2 === 0 ? z / 2 : -(z + 1) / 2) + 1;
    table[pointer] = codePoint;
  }
  return table;
}

function table(encoding: CjkEncoding, m: IndexModule): Uint32Array {
  let t = tables.get(encoding);
  if (t === undefined) {
    t =
      encoding === "euc-kr"
        ? expand(m.EUC_KR, m.EUC_KR_SIZE)
        : encoding === "big5"
          ? expand(m.BIG5, m.BIG5_SIZE)
          : expand(m.JIS0208, m.JIS0208_SIZE);
    tables.set(encoding, t);
  }
  return t;
}

/** UTF-16 output; every decoder emits at most one code unit per input byte. */
class Output {
  readonly #units: Uint16Array;
  #length = 0;

  constructor(capacity: number) {
    this.#units = new Uint16Array(capacity + 1);
  }

  push(codePoint: number): void {
    if (codePoint > 0xffff) {
      const v = codePoint - 0x10000;
      this.#units[this.#length++] = 0xd800 + (v >> 10);
      this.#units[this.#length++] = 0xdc00 + (v & 0x3ff);
    } else {
      this.#units[this.#length++] = codePoint;
    }
  }

  toString(): string {
    let out = "";
    for (let i = 0; i < this.#length; i += 8192) {
      out += String.fromCharCode(...this.#units.subarray(i, Math.min(i + 8192, this.#length)));
    }
    return out;
  }
}

const lookup = (t: Uint32Array, pointer: number): number => (pointer >= 0 && pointer < t.length ? t[pointer]! : 0);

function eucKr(bytes: Uint8Array, t: Uint32Array): string {
  const out = new Output(bytes.length);
  let lead = 0;
  for (const b of bytes) {
    if (lead !== 0) {
      const pointer = b >= 0x41 && b <= 0xfe ? (lead - 0x81) * 190 + (b - 0x41) : -1;
      lead = 0;
      const cp = lookup(t, pointer);
      if (cp !== 0) {
        out.push(cp);
      } else {
        out.push(REPLACEMENT);
        // An ASCII byte is put back and decoded on its own.
        if (b < 0x80) out.push(b);
      }
    } else if (b < 0x80) out.push(b);
    else if (b >= 0x81 && b <= 0xfe) lead = b;
    else out.push(REPLACEMENT);
  }
  if (lead !== 0) out.push(REPLACEMENT);
  return out.toString();
}

// Big5 pointers that decode to two code points.
const BIG5_PAIRS: ReadonlyMap<number, readonly [number, number]> = new Map([
  [1133, [0x00ca, 0x0304]],
  [1135, [0x00ca, 0x030c]],
  [1164, [0x00ea, 0x0304]],
  [1166, [0x00ea, 0x030c]],
]);

function big5(bytes: Uint8Array, t: Uint32Array): string {
  const out = new Output(bytes.length);
  let lead = 0;
  for (const b of bytes) {
    if (lead !== 0) {
      const offset = b < 0x7f ? 0x40 : 0x62;
      const pointer = (b >= 0x40 && b <= 0x7e) || (b >= 0xa1 && b <= 0xfe) ? (lead - 0x81) * 157 + (b - offset) : -1;
      lead = 0;
      const pair = BIG5_PAIRS.get(pointer);
      const cp = lookup(t, pointer);
      if (pair !== undefined) {
        out.push(pair[0]);
        out.push(pair[1]);
      } else if (cp !== 0) {
        out.push(cp);
      } else {
        out.push(REPLACEMENT);
        if (b < 0x80) out.push(b);
      }
    } else if (b < 0x80) out.push(b);
    else if (b >= 0x81 && b <= 0xfe) lead = b;
    else out.push(REPLACEMENT);
  }
  if (lead !== 0) out.push(REPLACEMENT);
  return out.toString();
}

function shiftJis(bytes: Uint8Array, t: Uint32Array): string {
  const out = new Output(bytes.length);
  let lead = 0;
  for (const b of bytes) {
    if (lead !== 0) {
      const offset = b < 0x7f ? 0x40 : 0x41;
      const leadOffset = lead < 0xa0 ? 0x81 : 0xc1;
      const pointer = (b >= 0x40 && b <= 0x7e) || (b >= 0x80 && b <= 0xfc) ? (lead - leadOffset) * 188 + b - offset : -1;
      lead = 0;
      const cp = pointer >= 8836 && pointer <= 10715 ? 0xe000 - 8836 + pointer : lookup(t, pointer);
      if (cp !== 0) {
        out.push(cp);
      } else {
        out.push(REPLACEMENT);
        if (b < 0x80) out.push(b);
      }
    } else if (b <= 0x80) out.push(b);
    else if (b >= 0xa1 && b <= 0xdf) out.push(0xff61 - 0xa1 + b);
    else if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) lead = b;
    else out.push(REPLACEMENT);
  }
  if (lead !== 0) out.push(REPLACEMENT);
  return out.toString();
}

/** Decode with the WHATWG algorithm, or undefined when the tables are not loaded yet. */
export function decodeCjk(encoding: CjkEncoding, bytes: Uint8Array): string | undefined {
  if (index === undefined) return undefined;
  const t = table(encoding, index);
  if (encoding === "euc-kr") return eucKr(bytes, t);
  return encoding === "big5" ? big5(bytes, t) : shiftJis(bytes, t);
}
