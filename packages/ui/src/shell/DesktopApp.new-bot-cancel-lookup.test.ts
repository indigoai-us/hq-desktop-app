/**
 * Cancel in the New Bot flow learns what a lost create made by reading the
 * company's bots (review A-C5). The shell hands the sidebar that read: the
 * member-safe roster, scoped to the company. It is a GET and creates nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AGENT_PATHS } from "@hq/platform";

const source = readFileSync(join(import.meta.dirname, "DesktopApp.svelte"), "utf8");

describe("DesktopApp: the read Cancel uses to look a bot up", () => {
  it("hands the sidebar the company roster read", () => {
    expect(source).toContain(
      "loadCompanyBots={(companyUid) => adapter.agents.listMobileRoster(companyUid)}",
    );
  });

  it("reads the roster of one company, by a path that only reads", () => {
    expect(AGENT_PATHS.mobileRoster("cmp_indigo")).toBe("/v1/agents/mobile-roster?companyUid=cmp_indigo");
  });
});

describe("DesktopApp: the key a bot's hello request is sent under (review item 8)", () => {
  it("sends the request under the key kept with the session, else the bot's own", () => {
    const send = source.slice(
      source.indexOf("async function sendCloudBotHello("),
      source.indexOf("async function cloudBotHelloArrived("),
    );
    expect(send).toContain("idempotencyKey: session.helloKey?.trim() || helloRequestKey(uid),");
    expect(send).not.toContain("`new-bot-hello-");
  });
});
