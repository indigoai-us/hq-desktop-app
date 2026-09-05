// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";
import IntegrationsTab from "./IntegrationsTab.svelte";
import { parseCompanyTab } from "./tab-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("IntegrationsTab", () => {
  it("renders connected and available rows for an owner", () => {
    const data = parseCompanyTab({
      tab: "integrations",
      companyUid: "cmp_acme",
      viewer: { canAct: true, role: "owner" },
      sections: [
        {
          id: "connected",
          title: "Connected · 1",
          rows: [
            {
              v: 1,
              type: "lifecycle_card",
              cardId: "int:connected:acct_slack",
              kind: "tab_row",
              companyUid: "cmp_acme",
              state: "open",
              fields: [
                { id: "name", label: "Name", control: "readonly", value: "Slack" },
                {
                  id: "account",
                  label: "Account",
                  control: "readonly",
                  value: "ramenbae.slack.com",
                },
              ],
              actions: [{ id: "disconnect", label: "Disconnect", style: "secondary" }],
              viewer: { canAct: true },
            },
          ],
        },
        {
          id: "available",
          title: "Available",
          rows: [
            {
              v: 1,
              type: "lifecycle_card",
              cardId: "int:available:linear",
              kind: "tab_row",
              companyUid: "cmp_acme",
              state: "open",
              fields: [
                { id: "name", label: "Name", control: "readonly", value: "Linear" },
              ],
              actions: [
                {
                  id: "connect",
                  label: "Connect",
                  style: "link",
                  href: "https://linear.app/oauth",
                },
              ],
              viewer: { canAct: true },
            },
          ],
        },
      ],
    });
    if (!data) throw new Error("fixture");
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(IntegrationsTab, { target: host, props: { data } });
    expect(host.querySelector('[data-testid="company-tab-integrations"]')).not.toBeNull();
    expect(host.textContent).toContain("Slack");
    expect(host.textContent).toContain("Linear");
    expect(
      host.querySelector('[data-testid="team-action-int:connected:acct_slack-disconnect"]'),
    ).not.toBeNull();
  });
});
