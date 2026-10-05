import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("installer canonical domain contract", () => {
  it("keeps the shipping installer step telemetry on telemetry.hq.computer", () => {
    const telemetry = read("apps/sync/src/lib/installer-step-telemetry.ts");
    expect(telemetry).toContain(
      "const DEFAULT_STEP_ENDPOINT = 'https://telemetry.hq.computer/v1/installer/step'",
    );
  });

  it("keeps the shipping vault API default on hqapi.hq.computer", () => {
    const sync = read("apps/sync/src-tauri/src/commands/sync.rs");
    expect(sync).toContain(
      'const DEFAULT_VAULT_API_URL: &str = "https://hqapi.hq.computer"',
    );
  });
});
