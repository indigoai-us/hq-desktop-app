import { describe, expect, it } from "vitest";

import { topicsForBundle } from "../../../core/src/mesh/client.js";

describe("project activity subscriptions", () => {
  it("builds company thread and presence subscriptions for project activity", () => {
    const topics = topicsForBundle({
      credentials: {
        accessKeyId: "AKIA_TEST",
        secretAccessKey: "secret-test",
        sessionToken: "session-test",
      },
      expiration: "2030-01-01T00:00:00.000Z",
      iotEndpoint: "example-ats.iot.us-east-1.amazonaws.com",
      region: "us-east-1",
      personUid: "prs_test",
      companyTopics: ["cmp_ramenbae"],
      droppedCompanies: [],
    });

    expect(topics).toContain("hq/cmp_ramenbae/thread/#");
    expect(topics).toContain("hq/cmp_ramenbae/presence/#");
    expect(topics).toContain("hq/cmp_ramenbae/thread-directory");
  });
});
