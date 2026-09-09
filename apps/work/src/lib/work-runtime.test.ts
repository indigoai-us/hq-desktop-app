import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveHostPlatform } from "@hq/platform";
import { describe, expect, it } from "vitest";

import { workRuntimeFor } from "./work-runtime";

describe("work runtime", () => {
  it("gives a real desktop host the native command bridge", () => {
    expect(workRuntimeFor("desktop")).toBe("desktop");
  });

  it.each(["ios", "android"] as const)(
    "puts %s on the network transport, not the command bridge",
    (platform) => {
      // The mobile shell exposes no commands. Handing it the Sync adapter
      // fails every call with "Cannot read properties of undefined (reading
      // 'invoke')" — which is what the first mobile build did.
      expect(workRuntimeFor(platform)).toBe("web");
    },
  );

  it("leaves the browser on the network transport", () => {
    expect(workRuntimeFor("web")).toBe("web");
  });

  it("routes a phone's own host probe to the network transport", () => {
    // End to end through the real resolver: a native shell reporting iOS.
    const probe = resolveHostPlatform({ tauri: true, osPlatform: "ios" });
    expect(probe).toBe("ios");
    expect(workRuntimeFor(probe)).toBe("web");
  });

  it("is the decision the shell actually makes", () => {
    // A pure function nothing calls would pass every case above and change
    // nothing on a phone.
    const shell = readFileSync(
      fileURLToPath(new URL("./WorkShell.svelte", import.meta.url)),
      "utf8",
    );
    expect(shell).toContain(
      "const runtime = runtimeKind ?? workRuntimeFor(resolveHostPlatform());",
    );
  });
});
