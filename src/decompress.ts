// SPDX-License-Identifier: Apache-2.0
// Content-Encoding decoding for the default HTTP path (an injected fetch decodes
// on its own). The rules, identical in every sdo SDK:
//
//   - the header is a comma list (trimmed, case-insensitive) undone in REVERSE
//     order: the coding applied last is removed first;
//   - gzip and x-gzip (concatenated members are joined; data after the final
//     member is ignored), deflate (zlib-wrapped or raw) and br are decoded;
//     identity is skipped;
//   - any other coding stops decoding, and the bytes are returned as they are
//     at that point;
//   - an empty body is empty whatever the coding;
//   - a truncated or corrupt stream is an error (the caller maps it to a
//     transport error that is never retried), and so is a chain of more than
//     MAX_CONTENT_CODINGS codings to decode, whatever the body.
//
// Decoding streams: each stage pulls from the one before it, and the output of
// every stage is bounded, so a small compressed payload cannot inflate a large
// buffer before the size ceiling stops it.
import { Readable, pipeline, type Transform } from "node:stream";
import zlib from "node:zlib";
import { trimChars } from "./headers.js";

export type ByteSource = AsyncIterable<Uint8Array>;

/** The codings to undo, in the order to undo them. */
export function contentCodings(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((c) => trimChars(c, " \t").toLowerCase())
    .filter((c) => c !== "")
    .reverse();
}

// A zlib stream (RFC 1950) starts with CMF/FLG: compression method 8, a window
// of at most 32 KiB, and a header checksum that is a multiple of 31.
function isZlibHeader(head: Uint8Array): boolean {
  const cmf = head[0]!;
  const flg = head[1]!;
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0;
}

const DECODERS: Readonly<Record<string, (head: Uint8Array) => Transform>> = {
  gzip: () => zlib.createGunzip(),
  "x-gzip": () => zlib.createGunzip(),
  deflate: (head) => (head.length >= 2 && isZlibHeader(head) ? zlib.createInflate() : zlib.createInflateRaw()),
  br: () => zlib.createBrotliDecompress(),
};

/** Thrown when one decoding step produces more than the ceiling allows. */
export class StageTooLarge extends Error {}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function* stage(source: ByteSource, create: (head: Uint8Array) => Transform, limit: number): ByteSource {
  const it = source[Symbol.asyncIterator]();
  // Peek at the first bytes: an empty input decodes to nothing, and deflate
  // picks its wrapper from the first two bytes.
  const peeked: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  while (size < 2) {
    const r = await it.next();
    if (r.done) {
      ended = true;
      break;
    }
    peeked.push(r.value);
    size += r.value.length;
  }
  if (size === 0) return;
  const head = concat(peeked);
  const input = (async function* () {
    try {
      yield head;
      while (!ended) {
        const r = await it.next();
        if (r.done) return;
        yield r.value;
      }
    } finally {
      // Releases the source when decoding stops early.
      await it.return?.();
    }
  })();
  const decoder = create(head);
  pipeline(Readable.from(input), decoder, () => undefined);
  let produced = 0;
  for await (const chunk of decoder as AsyncIterable<Uint8Array>) {
    produced += chunk.length;
    if (produced > limit) throw new StageTooLarge();
    yield chunk;
  }
}

/**
 * The most codings one body is decoded through (urllib3's limit too). Each
 * stage holds its own decoder state and buffers, and the target controls the
 * header, so a chain of thousands would cost memory and time before the size
 * ceiling could stop anything.
 */
export const MAX_CONTENT_CODINGS = 5;

/**
 * The body with its Content-Encoding undone, as a stream. `codings` comes from
 * contentCodings(); every stage stops once it has produced more than `limit`
 * bytes (StageTooLarge). Stream errors of a decoder propagate as they are; a
 * chain longer than MAX_CONTENT_CODINGS fails on the first read.
 */
export function decodeBody(body: ByteSource, codings: readonly string[], limit: number): ByteSource {
  const decoders: Array<(head: Uint8Array) => Transform> = [];
  for (const coding of codings) {
    if (coding === "identity") continue;
    const create = DECODERS[coding];
    if (create === undefined) break;
    if (decoders.length === MAX_CONTENT_CODINGS) return tooManyCodings();
    decoders.push(create);
  }
  let out = body;
  for (const create of decoders) out = stage(out, create, limit);
  return out;
}

async function* tooManyCodings(): ByteSource {
  throw new Error(`more than ${MAX_CONTENT_CODINGS} content codings`);
}
