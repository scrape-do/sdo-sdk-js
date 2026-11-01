// SPDX-License-Identifier: Apache-2.0
// Test-suite guards, loaded before every test file (vitest setupFiles).
//
// 1. Hermetic environment: the client reads SDO_TOKEN, SDO_BASE_URL,
//    SDO_ASYNC_BASE_URL and SDO_TIMEOUT, so none of them may leak in from the
//    shell that runs the suite. They are deleted from this worker's environment
//    outright (so vi.unstubAllEnvs() can never bring a shell value back) and
//    cleared again around each test. Tests that need one set it with vi.stubEnv.
// 2. No network: a socket may only connect to the loopback interface, so a test
//    that forgets its local server fails loudly instead of reaching a real host.
import net from "node:net";
import { afterEach, beforeEach, vi } from "vitest";

for (const name of Object.keys(process.env)) {
  if (name.startsWith("SDO_")) delete process.env[name];
}

function clearSdoEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("SDO_")) vi.stubEnv(name, undefined);
  }
}

beforeEach(clearSdoEnv);
afterEach(() => {
  vi.unstubAllEnvs();
});

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const GUARDED = Symbol.for("sdo.test.networkGuard");
const proto = net.Socket.prototype as net.Socket & { [GUARDED]?: true };
if (!proto[GUARDED]) {
  const connect = proto.connect;
  proto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    // net.connect() hands over its normalized arguments as an array.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host = "localhost";
    if (first !== null && typeof first === "object") {
      const o = first as { host?: string; port?: unknown; path?: unknown };
      // Only a connection without a port is a local pipe; an HTTP agent passes
      // the request path along with host and port.
      const pipe = o.port === undefined && typeof o.path === "string";
      if (!pipe) host = o.host ?? "localhost";
    } else if (typeof args[1] === "string") {
      host = args[1];
    }
    if (!LOOPBACK.has(host)) throw new Error(`test network guard: refusing to connect to ${host}`);
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof proto.connect;
  proto[GUARDED] = true;
}
