// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import { resolveLabel, sniffEncoding } from "../src/decoding.js";
import { SdoTransportError } from "../src/errors.js";
import { ScrapeResult } from "../src/response.js";
import { mockFetch } from "./helpers.js";

function make(content: Uint8Array, headers: Record<string, string | string[]> = {}, status = 200): ScrapeResult {
  return new ScrapeResult({ content, statusCode: status, headers, url: "https://e.com" });
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("ScrapeResult", () => {
  it("exposes a tri-modal body", () => {
    const r = make(enc('{"a": 1}'), { "Content-Type": "application/json" });
    expect(new TextDecoder().decode(r.bytes())).toBe('{"a": 1}');
    expect(r.text).toBe('{"a": 1}');
    expect(r.json()).toEqual({ a: 1 });
  });

  it("exposes typed header metadata", () => {
    const r = make(enc("ok"), {
      "Scrape.do-Request-Cost": "10",
      "Scrape.do-Remaining-Credits": "999",
    });
    expect(r.cost).toBe(10);
    expect(r.remainingCredits).toBe(999);
  });

  it("lower-cases header keys", () => {
    const r = make(enc(""), { "Content-Type": "text/html" });
    expect(r.contentType).toBe("text/html");
  });

  it("exposes the scrape.do-* enrichment accessors", () => {
    const r = make(enc("ok"), {
      "Scrape.do-Initial-Status-Code": "503",
      "Scrape.do-Target-Url": "https://target.example/page",
      "Scrape.do-Resolved-Url": "https://target.example/final",
      "Scrape.do-Cookies": "a=b; c=d",
    });
    expect(r.initialStatusCode).toBe(503);
    expect(r.targetUrl).toBe("https://target.example/page");
    expect(r.resolvedUrl).toBe("https://target.example/final");
    expect(r.cookies).toBe("a=b; c=d");
  });

  it("returns undefined for absent enrichment headers", () => {
    const bare = make(enc("ok"));
    expect(bare.initialStatusCode).toBeUndefined();
    expect(bare.targetUrl).toBeUndefined();
    expect(bare.resolvedUrl).toBeUndefined();
    expect(bare.cookies).toBeUndefined();
  });
});

describe("sniffEncoding", () => {
  const pick = (body: Uint8Array, ct?: string) => sniffEncoding(body, ct).encoding;
  it("resolves an explicit Content-Type charset through the WHATWG label table", () => {
    expect(pick(enc("abc"), "text/html; charset=iso-8859-1")).toBe("windows-1252");
    expect(pick(enc("abc"), "text/html; charset='utf-8'")).toBe("utf-8");
  });
  it("defaults JSON to utf-8 without sniffing <meta>", () => {
    expect(pick(enc("<meta charset='windows-1254'>"), "application/json")).toBe("utf-8");
  });
  it("reads a <meta charset> tag in HTML", () => {
    expect(pick(enc("<html><head><meta charset='windows-1254'>"), "text/html")).toBe("windows-1254");
    expect(pick(enc("<meta charset=koi8-r>"))).toBe("koi8-r");
  });
  it("skips a meta tag without a usable label and keeps scanning", () => {
    expect(pick(enc('<meta name="x"><meta charset="bogus"><meta charset="iso-8859-2">'), "text/html")).toBe(
      "iso-8859-2",
    );
    expect(pick(enc('<meta http-equiv="refresh" content="0; charset=koi8-r">'), "text/html")).toBe("utf-8");
  });
  it("maps a <meta> x-user-defined to windows-1252, as the HTML standard does", () => {
    expect(pick(enc('<meta charset="x-user-defined">'), "text/html")).toBe("windows-1252");
  });
  it("defaults to utf-8", () => {
    expect(pick(enc("plain"), "text/html")).toBe("utf-8");
  });
  it("lets a BOM decide and reports its length", () => {
    expect(sniffEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x68]), "text/plain; charset=latin1")).toEqual({
      encoding: "utf-8",
      bomLength: 3,
    });
    expect(sniffEncoding(new Uint8Array([0xff, 0xfe, 0x68, 0x00]))).toEqual({ encoding: "utf-16le", bomLength: 2 });
    expect(sniffEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x68]))).toEqual({ encoding: "utf-16be", bomLength: 2 });
  });
});

describe("Content-Type and <meta> parsing edges", () => {
  const pick = (body: Uint8Array, ct?: string) => sniffEncoding(body, ct).encoding;
  it("skips parameters without a value and tolerates an unterminated quote", () => {
    expect(pick(enc("x"), "text/plain; format; charset=\"koi8-r")).toBe("koi8-r");
  });
  it("follows WHATWG MIME parameter rules: first charset wins, only double quotes unquote", () => {
    expect(pick(enc("x"), "text/plain; charset=iso-8859-2; charset=utf-8")).toBe("iso-8859-2");
    expect(pick(enc("x"), "text/plain; charset='shift_jis'")).toBe("utf-8");
    expect(pick(enc("x"), 'text/plain; charset="sh\\ift_jis" ; x=1')).toBe("shift_jis");
    expect(pick(enc("x"), "text/plain; charset=koi8-r \t")).toBe("koi8-r");
    expect(pick(enc("x"), "text/plain; charset=\u0100; charset=koi8-r")).toBe("koi8-r");
    expect(pick(enc("x"), "text/plain; charset")).toBe("utf-8");
    expect(pick(enc("x"), "text/plain; charset=")).toBe("utf-8");
    // A blank unquoted value is no charset, so a later one still counts.
    expect(pick(enc("x"), "text/plain; charset= ; charset=koi8-r")).toBe("koi8-r");
    // A trailing backslash is kept by the quoted-string rules, so this label is no encoding.
    expect(pick(enc("x"), 'text/plain; charset="gbk\\')).toBe("utf-8");
  });

  it("prescans like the HTML standard: comments and other tags' attributes are skipped", () => {
    const html = (s: string) => pick(enc(s), "text/html");
    expect(html('<!-- <meta charset="koi8-r"> --><p>')).toBe("utf-8");
    expect(html('<!--> <meta charset=koi8-r> -->')).toBe("utf-8");
    expect(html('<div title="<meta charset=koi8-r>">x</div>')).toBe("utf-8");
    expect(html('<!DOCTYPE html><?xml x?></p ><META CHARSET="KOI8-R">')).toBe("koi8-r");
    expect(html(`${" ".repeat(1001)}<meta charset="koi8-r">`)).toBe("koi8-r"); // ">" is byte 1023
    expect(html(`${" ".repeat(1002)}<meta charset="koi8-r">`)).toBe("utf-8"); // ">" is byte 1024
    expect(html('<meta charset="koi8-r" charset="gbk">')).toBe("koi8-r"); // a repeated attribute is ignored
    expect(html('<meta http-equiv="content-type" content="text/html; charset=\'koi8-r\'">')).toBe("koi8-r");
    expect(html('<meta content="text/html; charset=koi8-r">')).toBe("utf-8"); // no http-equiv
    expect(html('<meta http-equiv=content-type content="charsetx; charset = koi8-r;x">')).toBe("koi8-r");
    expect(html('<meta http-equiv=content-type content="charset=\'koi8-r">')).toBe("utf-8");
    expect(html('<meta http-equiv=content-type content="charset=">')).toBe("utf-8");
    expect(html('<meta http-equiv=content-type content="charset">')).toBe("utf-8");
    expect(html('<meta charset="utf-16le">')).toBe("utf-8");
    expect(html('<meta charset=bogus><meta charset=koi8-r>')).toBe("koi8-r");
    expect(html("<meta name=x charset = koi8-r />")).toBe("koi8-r");
    expect(html("<meta charset=koi8-r/>")).toBe("utf-8"); // an unquoted value runs to a space or ">"
    expect(html("<meta charset=koi8-r")).toBe("utf-8"); // never closes
    expect(html('<meta\u212Aoi8>')).toBe("utf-8");
    expect(html("<!-- never closed")).toBe("utf-8");
    expect(html("<! never closed")).toBe("utf-8");
    expect(html('<a =x href="y"><meta charset="koi8-r>')).toBe("utf-8");
    // A name that runs into "/" or ">" is a valueless attribute: no label, keep scanning.
    expect(html("<meta x/><meta charset><meta charset=koi8-r>")).toBe("koi8-r");
    // The window ends inside an attribute name, or after one, before any "=".
    expect(html(`${" ".repeat(1017)}<meta charset=koi8-r>`)).toBe("utf-8");
    expect(html(`${" ".repeat(1010)}<meta charset    `)).toBe("utf-8");
  });

  it("handles valueless attributes and an http-equiv without content", () => {
    expect(pick(enc('<meta async http-equiv="Content-Type"><meta charset=koi8-r>'), "text/html")).toBe("koi8-r");
  });
});

describe("resolveLabel", () => {
  it("follows the WHATWG table and refuses replacement or unknown labels", () => {
    expect(resolveLabel(" Latin1 ")).toBe("windows-1252");
    expect(resolveLabel("X-User-Defined")).toBe("x-user-defined");
    expect(resolveLabel("iso-2022-kr")).toBeUndefined();
    expect(resolveLabel("utf-7")).toBeUndefined();
  });
});

describe("text decoding", () => {
  it("decodes via the declared charset", () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // café
    const r = make(latin1, { "Content-Type": "text/plain; charset=latin1" });
    expect(r.text).toBe("café");
  });

  it("decodes a UTF-8 BOM body and strips the BOM", () => {
    const r = make(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])); // BOM + "hi"
    expect(r.text).toBe("hi");
  });

  it("decodes a UTF-16 LE BOM body and strips the BOM", () => {
    const r = make(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])); // LE BOM + "hi"
    expect(r.text).toBe("hi");
  });

  it("decodes a UTF-16 BE BOM body and strips the BOM", () => {
    const r = make(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])); // BE BOM + "hi"
    expect(r.text).toBe("hi");
  });

  it("keeps the WHATWG correction of a table-decoded encoding on every body", () => {
    // windows-1255 decodes through a per-byte table built once; 0xCA is U+05BA
    // there even where the runtime's ICU table disagrees.
    const decode = (...b: number[]) => make(Uint8Array.from(b), { "Content-Type": "text/plain; charset=windows-1255" }).text;
    expect(decode(0xca)).toBe("\u05ba");
    expect(decode(0x41, 0xca, 0xe0)).toBe("A\u05ba\u05d0");
  });

  it("falls back to utf-8 when the declared charset is bogus", () => {
    const r = make(enc("hi"), { "Content-Type": "text/plain; charset=not-a-real-charset" });
    expect(r.text).toBe("hi");
  });
});

describe("repeated headers", () => {
  it("keeps every Set-Cookie line apart when built from fetch Headers", () => {
    const h = new Headers();
    h.append("Set-Cookie", "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    h.append("Set-Cookie", "b=2");
    h.append("X-Multi", "x");
    h.append("X-Multi", "y");
    const r = new ScrapeResult({ content: enc(""), statusCode: 200, headers: h, url: "https://e.com" });
    expect(r.headerValues("set-cookie")).toEqual(["a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "b=2"]);
    expect(r.headerValues("X-Multi")).toEqual(["x, y"]);
    expect(r.headerValues("absent")).toEqual([]);
    expect(r.headers["set-cookie"]).toBe("a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2");
  });

  it("accepts a list of values per name in a plain object", () => {
    const r = make(enc(""), { "Set-Cookie": ["a=1", "b=2"], Via: "1.1 x" });
    expect(r.headerValues("SET-COOKIE")).toEqual(["a=1", "b=2"]);
    expect(r.headers.via).toBe("1.1 x");
  });

  it("returns a result's headers from the real response", async () => {
    const f = mockFetch(() => {
      const h = new Headers([["set-cookie", "a=1"]]);
      h.append("set-cookie", "b=2");
      return new Response("ok", { headers: h });
    });
    const r = await new Client({ token: "t", fetchImpl: f }).scrape("https://e.com");
    expect(r.headerValues("set-cookie")).toEqual(["a=1", "b=2"]);
  });
});

describe("json()", () => {
  it("ignores a leading UTF-8 BOM", () => {
    expect(make(new Uint8Array([0xef, 0xbb, 0xbf, 0x5b, 0x5d])).json()).toEqual([]);
  });

  it("raises an SdoError for a body that is not JSON", () => {
    expect(() => make(enc("<html>")).json()).toThrow(SdoTransportError);
  });
});
