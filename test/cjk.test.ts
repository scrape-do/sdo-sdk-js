// SPDX-License-Identifier: Apache-2.0
// The WHATWG decoders for EUC-KR, Big5 and Shift_JIS, and how their tables are
// loaded. (The conformance corpus pins the cases where the runtime's
// TextDecoder is wrong; this file pins the algorithms' other branches.)
import { describe, expect, it } from "vitest";
import { decodeCjk, loadCjkTables } from "../src/cjk.js";
import { prepareDecoding } from "../src/decoding.js";
import { ScrapeResult } from "../src/response.js";

const bytes = (...b: number[]) => Uint8Array.from(b);
const cps = (s: string | undefined) => [...(s ?? "")].map((c) => c.codePointAt(0)!.toString(16));
const html = (charset: string, body: Uint8Array) =>
  new ScrapeResult({ content: body, statusCode: 200, headers: { "content-type": `text/html; charset=${charset}` }, url: "u" });

describe("before the tables are loaded", () => {
  it("a hand-built result falls back to the runtime's decoder", async () => {
    expect(decodeCjk("euc-kr", bytes(0xb0, 0xa1))).toBeUndefined();
    expect(html("euc-kr", bytes(0xb0, 0xa1)).text).toBe("가");
    // Only a body that needs a table loads it.
    await prepareDecoding(bytes(0x41), "text/html; charset=utf-8");
    expect(decodeCjk("big5", bytes(0x41))).toBeUndefined();
    await prepareDecoding(bytes(0x41), "text/html; charset=shift_jis");
    expect(decodeCjk("big5", bytes(0x41))).toBe("A");
  });
});

describe("with the tables loaded", () => {
  it("decodes EUC-KR, including the UHC extension", async () => {
    await loadCjkTables();
    expect(decodeCjk("euc-kr", bytes(0xb0, 0xa1, 0x8c, 0x63, 0x41))).toBe("가똠A");
    // An unmapped pair gives U+FFFD and an ASCII second byte is decoded again.
    expect(cps(decodeCjk("euc-kr", bytes(0xc9, 0x41, 0xc9, 0xff)))).toEqual(["fffd", "41", "fffd"]);
    expect(cps(decodeCjk("euc-kr", bytes(0x80, 0xff, 0xb0)))).toEqual(["fffd", "fffd", "fffd"]);
    expect(html("euc-kr", bytes(0x8c, 0x63)).text).toBe("똠");
  });

  it("decodes Big5, including HKSCS pairs and astral code points", async () => {
    await loadCjkTables();
    expect(decodeCjk("big5", bytes(0xa4, 0x40))).toBe("一");
    expect(cps(decodeCjk("big5", bytes(0x88, 0x62, 0x88, 0x64, 0x88, 0xa3, 0x88, 0xa5)))).toEqual(
      ["ca", "304", "ca", "30c", "ea", "304", "ea", "30c"],
    );
    expect(cps(decodeCjk("big5", bytes(0x87, 0x45)))).toEqual(["27267"]);
    expect(cps(decodeCjk("big5", bytes(0x83, 0x46, 0x81, 0x30, 0xff, 0xa4)))).toEqual(
      ["fffd", "46", "fffd", "30", "fffd", "fffd"],
    );
    // An invalid trail byte that is not ASCII is consumed with the lead.
    expect(cps(decodeCjk("big5", bytes(0x81, 0xff, 0x41)))).toEqual(["fffd", "41"]);
  });

  it("decodes Shift_JIS, including half-width katakana, EUDC and 0x80", async () => {
    await loadCjkTables();
    expect(decodeCjk("shift_jis", bytes(0x82, 0xa0, 0x88, 0x9f, 0x1a))).toBe("あ亜\u001a");
    expect(cps(decodeCjk("shift_jis", bytes(0x80, 0xa1, 0xdf, 0xf0, 0x40)))).toEqual(["80", "ff61", "ff9f", "e000"]);
    expect(cps(decodeCjk("shift_jis", bytes(0x86, 0x6e, 0xa0, 0xfd, 0x81, 0x7f, 0xe0)))).toEqual(
      ["fffd", "6e", "fffd", "fffd", "fffd", "7f", "fffd"],
    );
    expect(cps(decodeCjk("shift_jis", bytes(0x81, 0xfd, 0x41)))).toEqual(["fffd", "41"]);
  });

  it("keeps a large body intact", async () => {
    await loadCjkTables();
    const body = new Uint8Array(40_000).fill(0x41);
    expect(decodeCjk("big5", body)).toBe("A".repeat(40_000));
  });
});
