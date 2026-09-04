import { describe, expect, it } from "vitest";

import { topicsForBundle } from "./client.js";
import { normalizeBundle } from "./credentials.js";

/** Shape hq-pro actually returns today (no top-level personUid). */
function hqProVendBody() {
  return {
    credentials: {
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "token",
      expiration: "2026-08-22T15:44:38.000Z",
    },
    iotEndpoint: "example-ats.iot.us-east-1.amazonaws.com",
    region: "us-east-1",
    topic: "hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/dm",
    topics: {
      dm: "hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/dm",
      notifications: "hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/notifications",
      sessions: "hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/sessions",
      work: "hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/work",
    },
    expiresAt: "2026-08-22T15:44:38.000Z",
    companyTopics: [
      {
        companyUid: "cmp_01KSR2D0Y920PD7NK0Z232DEK2",
        threadTopicFilter: "hq/cmp_01KSR2D0Y920PD7NK0Z232DEK2/thread/#",
        presenceTopic: "hq/cmp_01KSR2D0Y920PD7NK0Z232DEK2/presence",
      },
    ],
  };
}

describe("normalizeBundle", () => {
  it("derives personUid and company UIDs from the live hq-pro vend shape", () => {
    const bundle = normalizeBundle(hqProVendBody());
    expect(bundle.personUid).toBe("prs_01KQ2RY9VB1S105X2GZ2EPHKWY");
    expect(bundle.companyTopics).toEqual(["cmp_01KSR2D0Y920PD7NK0Z232DEK2"]);
    expect(topicsForBundle(bundle)).toEqual([
      "hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/dm",
      "hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/work",
      "hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/notifications",
      "hq/prs_01KQ2RY9VB1S105X2GZ2EPHKWY/work-session/#",
      "hq/cmp_01KSR2D0Y920PD7NK0Z232DEK2/thread/#",
      "hq/cmp_01KSR2D0Y920PD7NK0Z232DEK2/presence/#",
      "hq/cmp_01KSR2D0Y920PD7NK0Z232DEK2/thread-directory",
    ]);
    // Contract-1 presenceTopic (exact, no actor) is dropped — filter is derived.
    expect(topicsForBundle(bundle)).not.toContain(
      "hq/cmp_01KSR2D0Y920PD7NK0Z232DEK2/presence",
    );
    expect(topicsForBundle(bundle).every((t) => !t.includes("hq//"))).toBe(
      true,
    );
  });

  it("keeps a contract-v1 string companyTopics list and explicit personUid", () => {
    const bundle = normalizeBundle({
      credentials: {
        accessKeyId: "ASIAEXAMPLE",
        secretAccessKey: "secret",
        sessionToken: "token",
      },
      iotEndpoint: "example-ats.iot.us-east-1.amazonaws.com",
      region: "us-east-1",
      personUid: "prs_alice",
      companyTopics: ["cmp_acme"],
      droppedCompanies: ["cmp_big"],
    });
    expect(bundle.personUid).toBe("prs_alice");
    expect(bundle.companyTopics).toEqual(["cmp_acme"]);
    expect(bundle.droppedCompanies).toEqual(["cmp_big"]);
  });
});
