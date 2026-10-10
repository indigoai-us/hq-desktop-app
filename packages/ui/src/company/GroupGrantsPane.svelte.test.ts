// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import GroupGrantsPane from "./GroupGrantsPane.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

const ok = (value: unknown) => ({ ok: true as const, value: value as never });
const fail = (code: string) => ({ ok: false as const, reason: "error" as const, code, message: `${code} {"error":"stack trace"}` });

const targets = [
  { uid: "cmp_indigo", label: "Indigo", eligible: true },
  { uid: "cmp_kept", label: "Keptwork", eligible: true },
  { uid: "cmp_vyg", label: "VYG", eligible: false },
];

function filesApi(overrides: Record<string, unknown> = {}) {
  let outbound: unknown[] = [
    { groupId: "grp_ae", sourceCompanyUid: "cmp_indigo", targetCompanyUid: "cmp_kept", role: "admin", status: "revoked" },
    { groupId: "grp_dev", sourceCompanyUid: "cmp_indigo", targetCompanyUid: "cmp_01GONE", role: "admin", status: "revoked", targetCompanyName: "cmp_01GONE" },
  ];
  return {
    setOutbound: (rows: unknown[]) => (outbound = rows),
    listAccessGroups: vi.fn(async () => ok({ groups: [{ groupId: "grp_ae", name: "AE agent" }, { groupId: "grp_dev", name: "Dev Test" }] })),
    listOutboundGroupGrants: vi.fn(async (_s: string, groupId: string) => ok({ grants: outbound.filter((g) => (g as { groupId: string }).groupId === groupId) })),
    listInboundGroupGrants: vi.fn(async () => ok({ grants: [] })),
    createGroupGrant: vi.fn(async () => ok({ grant: {} })),
    revokeGroupGrant: vi.fn(async () => ok({ grant: {} })),
    ...overrides,
  };
}

function render(files: unknown, companyUid = "cmp_indigo") {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(GroupGrantsPane, { target, props: { companyUid, companyLabel: "Indigo", targets, files: files as never } }));
  flushSync();
  return target;
}

const q = (t: HTMLElement, id: string) => t.querySelector<HTMLElement>(`[data-testid='${id}']`);
const all = (t: HTMLElement, id: string) => [...t.querySelectorAll<HTMLElement>(`[data-testid='${id}']`)];
// Row text without the company icon's initials, which are decorative.
const read = (el: HTMLElement) => {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-testid='company-label-initials']").forEach((n) => n.remove());
  return copy.textContent!.replace(/\s+/g, " ").trim();
};
const text = (t: HTMLElement, id: string) => {
  const el = q(t, id);
  return el ? read(el) : "";
};

async function ready(t: HTMLElement) {
  await vi.waitFor(() => {
    flushSync();
    expect(q(t, "grant-form")).not.toBeNull();
  });
}

describe("GroupGrantsPane", () => {
  it("shows the console's sections, revoked rows with readable names, and no current company as a target", async () => {
    const files = filesApi();
    const t = render(files);
    expect(q(t, "grants-loading")).not.toBeNull();
    await ready(t);
    expect(text(t, "grants-sub")).toContain("Grant Indigo's groups access to other companies");
    expect(text(t, "outbound-grants-empty")).toBe("No active grants yet.");
    const revoked = all(t, "outbound-grant-revoked-row").map(read);
    expect(all(t, "outbound-grant-revoked-row").every((r) => r.querySelector("[data-testid='company-label']"))).toBe(true);
    expect(revoked).toEqual(["AE agent Keptwork Admin revoked", "Dev Test Unknown company Admin revoked"]);
    expect(all(t, "grant-target").map((b) => b.dataset.uid)).toEqual(["cmp_kept", "cmp_vyg"]);
    expect(all(t, "grant-target")[1]!.hasAttribute("disabled")).toBe(true);
    expect(t.textContent).not.toContain("cmp_");

    q(t, "grants-view-grants")!.click();
    flushSync();
    expect(text(t, "inbound-grants-empty")).toBe("No external groups currently have access.");
  });

  it("grants with an immediate pending state, blocks a second submit, and refreshes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const files = filesApi();
    files.createGroupGrant = vi.fn(async () => {
      await gate;
      return ok({ grant: {} });
    });
    const t = render(files);
    await ready(t);
    const submit = q(t, "grant-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    all(t, "grant-target")[0]!.click();
    flushSync();
    expect(all(t, "grant-target")[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(submit.disabled).toBe(false);
    const readsBefore = files.listOutboundGroupGrants.mock.calls.length;

    submit.click();
    flushSync();
    expect(submit.textContent).toContain("Granting…");
    expect(submit.disabled).toBe(true);
    submit.click();
    flushSync();
    expect(files.createGroupGrant).toHaveBeenCalledTimes(1);
    expect(files.createGroupGrant).toHaveBeenCalledWith({ groupId: "grp_ae", sourceCompanyUid: "cmp_indigo", targetCompanyUid: "cmp_kept", role: "member" });

    files.setOutbound([{ groupId: "grp_ae", sourceCompanyUid: "cmp_indigo", targetCompanyUid: "cmp_kept", role: "member", status: "active" }]);
    release();
    await vi.waitFor(() => {
      flushSync();
      expect(all(t, "outbound-grant-row")).toHaveLength(1);
    });
    expect(text(t, "grant-saved")).toBe("Access granted.");
    expect(files.listOutboundGroupGrants.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(text(t, "outbound-grant-row")).toContain("AE agent Keptwork Write active");
  });

  it("shows plain copy when a grant is refused, never the server text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = filesApi({ createGroupGrant: vi.fn(async () => fail("http-403")) });
    const t = render(files);
    await ready(t);
    all(t, "grant-target")[0]!.click();
    flushSync();
    q(t, "grant-submit")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(q(t, "grant-error")).not.toBeNull();
    });
    expect(text(t, "grant-error")).toContain("owner or admin");
    expect(t.textContent).not.toContain("stack trace");
    expect(all(t, "grant-target")[0]!.getAttribute("aria-pressed")).toBe("true");
    warn.mockRestore();
  });

  it("revokes only after confirming, then refreshes", async () => {
    const files = filesApi();
    files.setOutbound([{ groupId: "grp_ae", sourceCompanyUid: "cmp_indigo", targetCompanyUid: "cmp_kept", role: "guest", status: "active" }]);
    const t = render(files);
    await ready(t);
    await vi.waitFor(() => {
      flushSync();
      expect(q(t, "grant-revoke")).not.toBeNull();
    });
    q(t, "grant-revoke")!.click();
    flushSync();
    expect(files.revokeGroupGrant).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("AE agent will lose access to Keptwork.");
    const confirm = document.body.querySelector<HTMLButtonElement>("[data-testid='confirm-dialog-ok']");
    expect(confirm?.textContent?.trim()).toBe("Revoke");
    files.setOutbound([{ groupId: "grp_ae", sourceCompanyUid: "cmp_indigo", targetCompanyUid: "cmp_kept", role: "guest", status: "revoked" }]);
    confirm!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(all(t, "outbound-grant-revoked-row")).toHaveLength(1);
    });
    expect(files.revokeGroupGrant).toHaveBeenCalledWith({ sourceCompanyUid: "cmp_indigo", groupId: "grp_ae", targetCompanyUid: "cmp_kept" });
    expect(text(t, "outbound-grants-empty")).toBe("No active grants yet.");
  });

  it("says the read failed and retries instead of showing empty lists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let broken = true;
    const files = filesApi({ listAccessGroups: vi.fn(async () => (broken ? fail("http-500") : ok({ groups: [] }))) });
    // A company with no cached groups: earlier tests cached cmp_indigo's.
    const t = render(files, "cmp_uncached");
    await vi.waitFor(() => {
      flushSync();
      expect(q(t, "grants-failed")).not.toBeNull();
    });
    expect(q(t, "outbound-grants-empty")).toBeNull();
    broken = false;
    q(t, "grants-retry")!.click();
    await ready(t);
    expect(text(t, "grant-disabled-reason")).toContain("no groups");
    warn.mockRestore();
  });
});
