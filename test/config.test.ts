// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ScrapeConfig } from "../src/config.js";
import { SdoConfigError } from "../src/errors.js";

const U = "https://e.com";

function dict(cfg: ScrapeConfig): Record<string, string> {
  return Object.fromEntries(cfg.toParams());
}

describe("ScrapeConfig", () => {
  it("requires a url", () => {
    expect(() => new ScrapeConfig("")).toThrow(SdoConfigError);
  });

  it("serializes minimally", () => {
    expect(dict(new ScrapeConfig("https://example.com"))).toEqual({ url: "https://example.com" });
  });

  it("serializes true bools as lowercase strings", () => {
    const d = dict(new ScrapeConfig(U, { superProxy: true }));
    expect(d.super).toBe("true");
  });

  it("omits false bools entirely", () => {
    // A false boolean is absent from the wire, never `key=false` — Go cannot
    // express "explicitly false" and every gateway flag defaults to off.
    const d = dict(new ScrapeConfig(U, { superProxy: false, pureCookies: false }));
    expect(d).toEqual({ url: U });
  });

  it("uses camelCase wire names", () => {
    const d = dict(new ScrapeConfig(U, { geoCode: "us", returnJson: true, setCookies: "a=b", sessionId: "1234" }));
    expect(d.geoCode).toBe("us");
    expect(d.returnJSON).toBe("true");
    expect(d.setCookies).toBe("a=b");
    expect(d.sessionId).toBe("1234");
  });

  it("rejects render-only params without render", () => {
    expect(() => new ScrapeConfig(U, { screenshot: true }).toParams()).toThrow(SdoConfigError);
  });

  it("allows render-only params with render", () => {
    const d = dict(new ScrapeConfig(U, { render: true, returnJson: true, screenshot: true }));
    expect(d.render).toBe("true");
    expect(d.screenShot).toBe("true");
  });

  it("rejects render 'new', which the documentation does not list", () => {
    expect(() => new ScrapeConfig(U, { render: "new" as never })).toThrow(SdoConfigError);
  });

  // blockResources is tri-state: unset sends nothing (the gateway default,
  // true, applies), true is render-only, and false is sent so resources load.
  it("sends blockResources false, which needs no render", () => {
    expect(dict(new ScrapeConfig(U, { render: true, blockResources: false })).blockResources).toBe("false");
    expect(new ScrapeConfig(U, { blockResources: false }).toParams()).toEqual([
      ["url", U],
      ["blockResources", "false"],
    ]);
    expect(dict(new ScrapeConfig(U, { render: true }))).not.toHaveProperty("blockResources");
    expect(dict(new ScrapeConfig(U, { render: true, blockResources: undefined }))).not.toHaveProperty("blockResources");
    expect(() => new ScrapeConfig(U, { blockResources: true })).toThrow(SdoConfigError);
    expect(() => new ScrapeConfig(U, { blockResources: "false" as unknown as boolean })).toThrow(SdoConfigError);
  });

  it("serializes playWithBrowser as JSON", () => {
    const d = dict(new ScrapeConfig(U, { render: true, playWithBrowser: [{ action: "click", css: "#x" }] }));
    expect(d.playWithBrowser).toBe('[{"action":"click","css":"#x"}]');
  });

  it("rejects invalid enums", () => {
    expect(() => new ScrapeConfig(U, { device: "watch" as never }).toParams()).toThrow(SdoConfigError);
    expect(() => new ScrapeConfig(U, { output: "pdf" as never }).toParams()).toThrow(SdoConfigError);
    expect(() => new ScrapeConfig(U, { render: true, waitUntil: "whenever" as never }).toParams()).toThrow(
      SdoConfigError,
    );
  });

  it("supports the extraParams escape hatch", () => {
    const d = dict(new ScrapeConfig(U, { extraParams: { brandNewParam: "x", flag: true } }));
    expect(d.brandNewParam).toBe("x");
    expect(d.flag).toBe("true");
  });
});
