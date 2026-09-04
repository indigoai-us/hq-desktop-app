import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The root route has to load without a server behind it.
 *
 * Desktop and mobile ship the adapter-static bundle, which publishes the SPA
 * fallback document and nothing else. A `+page.server.ts` or `+layout.server.ts`
 * on this route makes SvelteKit's client router fetch `/__data.json` on the
 * very first navigation; a static bundle answers that with 404 and SvelteKit
 * renders its own 404 page. The native shell launches, the webview paints, and
 * the app is simply not there — with no error anywhere in the native logs,
 * because nothing native failed.
 *
 * That is exactly what shipped: both mobile targets built, installed and
 * launched to a blank screen. So the absence of a server load here is a
 * contract, not an incidental fact, and it is asserted structurally because
 * the failure it prevents is invisible to every unit test of the route itself.
 */

const ROOT_ROUTE = dirname(fileURLToPath(import.meta.url));

describe("the root route survives a build with no server", () => {
  it("declares no server load", () => {
    const serverLoads = readdirSync(ROOT_ROUTE).filter((name) =>
      /^\+(page|layout)\.server\.ts$/.test(name),
    );
    expect(
      serverLoads,
      "a server load on the root route makes the static build request /__data.json, which 404s",
    ).toEqual([]);
  });
});
