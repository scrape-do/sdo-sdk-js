// SPDX-License-Identifier: Apache-2.0
import type { FetchLike } from "../src/transport.js";

export interface MockCall {
  url: string;
  init?: RequestInit;
}

/** A fetch mock that records calls and returns responses from a handler. */
export function mockFetch(
  handler: (url: string, init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>,
): FetchLike & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const idx = calls.length;
    calls.push({ url, init });
    return handler(url, init, idx);
  }) as FetchLike & { calls: MockCall[] };
  fn.calls = calls;
  return fn;
}

/** Build a fetch mock that returns each response in sequence. */
export function sequence(...responses: Response[]): FetchLike & { calls: MockCall[] } {
  return mockFetch((_u, _i, idx) => responses[Math.min(idx, responses.length - 1)]!);
}

/** A request header by name, compared case-insensitively. */
export function header(init: RequestInit | undefined, name: string): string | undefined {
  const h = (init?.headers ?? {}) as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : h[key];
}

export function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

/** The query string exactly as sent (not re-parsed or re-encoded). */
export function rawQuery(url: string): string {
  const i = url.indexOf("?");
  return i < 0 ? "" : url.slice(i + 1);
}

/** The request body as UTF-8 text, or undefined when none was sent. */
export function bodyText(init: RequestInit | undefined): string | undefined {
  const body = init?.body;
  if (body === undefined || body === null) return undefined;
  return new TextDecoder().decode(body as Uint8Array);
}

/** A response whose body never arrives: it stays open until the reader gives up. */
export function stalledBody(prefix = new Uint8Array([0x61])): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(prefix);
        return;
      }
      return new Promise<void>(() => undefined);
    },
  });
}
