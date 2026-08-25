import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("installer canonical domain contract", () => {
  it("runs the onboarding handoff smoke against canonical production hosts", () => {
    const source = read("imports/hq-installer-react/scripts/e2e-installer-handoff.ts");
    expect(source).toContain('const VAULT_API_URL = "https://hqapi.hq.computer"');
    expect(source).toContain('const ONBOARDING_URL = "https://onboarding.hq.computer"');
    expect(source).not.toContain("onboarding.getindigo.ai");
  });

  it("keeps installer API and telemetry defaults on hq.computer", () => {
    const telemetry = read("imports/hq-installer-react/src/lib/telemetry.ts");
    const handoff = read("imports/hq-installer-react/src/lib/vault-handoff.ts");
    expect(telemetry).toContain("https://telemetry.hq.computer/v1/installer/success");
    expect(telemetry).toContain('const DEFAULT_VAULT_API_URL = "https://hqapi.hq.computer"');
    expect(handoff).toContain('const DEFAULT_VAULT_API_URL = "https://hqapi.hq.computer"');
  });
});
