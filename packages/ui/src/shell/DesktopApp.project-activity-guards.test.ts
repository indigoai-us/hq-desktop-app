import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(
  join(here, "../../../core/src/mesh/client.ts"),
  "utf8",
);

describe("project activity — component contracts", () => {
  it("the realtime client still subscribes to the company thread topic", () => {
    // Work-mesh thread events fan out on hq/{companyUid}/thread/#; without this
    // subscription the timeline would only update on reopen.
    expect(clientSrc).toContain("thread/#");
    expect(clientSrc).toContain("presence/#");
  });
});
