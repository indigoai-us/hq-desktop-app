// @vitest-environment happy-dom

/**
 * DEV-5255 (feedback_9e78cb18-a7a6-4f63-a00a-187d68ce203e): Invite teammate on
 * the Team page only added a local row. No invite reached hq-pro, so no email
 * went out, and the next roster read wiped the row. These cases pin the fixed
 * contract: Send invite calls the server, a pending row appears only after the
 * server confirms it, a refusal shows an error, and the roster read is the
 * source of truth for pending invites.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import TeamPage from "./TeamPage.svelte";
import { readTeamCache, writeTeamCache } from "./team-bots-pages.js";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

const OWNER = { personUid: "prs_owner", displayName: "Rory Owner", email: "rory@example.com" };

type Pending = Array<Record<string, unknown>>;

function companyApi(opts: {
  pending?: () => Pending;
  invite?: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  return {
    getTeamTelemetry: vi.fn(async () => ({ ok: true as const, value: { perMember: [] } })),
    listMembers: vi.fn(async () => ({ ok: true as const, value: [OWNER] })),
    listCompanyMemberships: vi.fn(async () => ({
      ok: true as const,
      value: { members: [{ membershipKey: "prs_owner#cmp_acme", personUid: "prs_owner", role: "owner" }] },
    })),
    listPendingMemberships: vi.fn(async () => ({ ok: true as const, value: { pending: opts.pending?.() ?? [] } })),
    ...(opts.invite ? { inviteMember: vi.fn(opts.invite) } : {}),
  };
}

function render(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(TeamPage, { target, props: { selfUid: "prs_owner", ...props } as never }));
  flushSync();
  return target;
}

async function ready(target: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelectorAll("[data-testid='team-row']").length).toBeGreaterThan(0);
  });
}

function pendingEmails(target: HTMLElement): string[] {
  return [...target.querySelectorAll("[data-testid='pending-invites'] li .nm")].map((el) => el.textContent?.trim() ?? "");
}

function openSheetAndType(target: HTMLElement, email: string): void {
  (target.querySelector("[data-testid='invite-teammate']") as HTMLButtonElement).click();
  flushSync();
  const input = target.querySelector<HTMLInputElement>("#invite-email")!;
  input.value = email;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function send(target: HTMLElement): void {
  (target.querySelector("[data-testid='invite-send']") as HTMLButtonElement).click();
  flushSync();
}

describe("TeamPage invite (DEV-5255)", () => {
  it("sends the invite to the server and shows the pending row only after the server confirms it", async () => {
    let answer!: (value: unknown) => void;
    const company = companyApi({
      invite: () => new Promise((resolve) => (answer = resolve)),
    });
    const target = render({ slug: "acme-invite-ok", companyUid: "cmp_acme", company });
    await ready(target);

    openSheetAndType(target, "kade@hikerhunger.com");
    send(target);

    expect(company.inviteMember).toHaveBeenCalledTimes(1);
    expect(company.inviteMember).toHaveBeenCalledWith(
      expect.objectContaining({ companyUid: "cmp_acme", inviteeEmail: "kade@hikerhunger.com", role: "member" }),
    );
    // Nothing is shown as pending while the server has not answered.
    expect(pendingEmails(target)).toEqual([]);

    answer({
      ok: true,
      value: {
        membership: {
          membershipKey: "email:kade@hikerhunger.com#cmp_acme",
          inviteeEmail: "kade@hikerhunger.com",
          role: "member",
          status: "pending",
          invitedAt: new Date().toISOString(),
        },
        emailSent: true,
      },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(pendingEmails(target)).toEqual(["kade@hikerhunger.com"]);
    });
    expect(target.querySelector("[data-testid='invite-sheet']")).toBeNull();
    // The row carries the server's membership key, so Revoke reaches the real invite.
    expect(target.querySelector("[data-testid='revoke-email:kade@hikerhunger.com#cmp_acme']")).not.toBeNull();
    expect(readTeamCache("acme-invite-ok")?.invites.map((i) => i.id)).toEqual(["email:kade@hikerhunger.com#cmp_acme"]);
  });

  it("shows an error, adds no row and keeps the sheet open when the server refuses the invite", async () => {
    const company = companyApi({
      invite: async () => ({
        ok: false,
        reason: "error",
        code: "PLAN_LIMIT_EXCEEDED",
        message: "Your plan limit is reached. Members: 5 of 5 used.",
      }),
    });
    const target = render({ slug: "acme-invite-refused", companyUid: "cmp_acme", company });
    await ready(target);

    openSheetAndType(target, "kade@hikerhunger.com");
    send(target);

    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("[data-testid='invite-error']")?.textContent).toContain(
        "Your plan limit is reached. Members: 5 of 5 used.",
      );
    });
    expect(pendingEmails(target)).toEqual([]);
    expect(target.querySelector("[data-testid='invite-sheet']")).not.toBeNull();
    expect(readTeamCache("acme-invite-refused")?.invites ?? []).toEqual([]);
  });

  it("shows an error and adds no row when the request itself fails", async () => {
    const company = companyApi({ invite: async () => Promise.reject(new Error("offline")) });
    const target = render({ slug: "acme-invite-throws", companyUid: "cmp_acme", company });
    await ready(target);

    openSheetAndType(target, "kade@hikerhunger.com");
    send(target);

    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("[data-testid='invite-error']")).not.toBeNull();
    });
    expect(pendingEmails(target)).toEqual([]);
  });

  it("never shows a local-only row when the host cannot send invites", async () => {
    const company = companyApi({});
    const target = render({ slug: "acme-invite-unsupported", companyUid: "cmp_acme", company });
    await ready(target);

    openSheetAndType(target, "kade@hikerhunger.com");
    send(target);
    flushSync();

    expect(target.querySelector("[data-testid='invite-error']")).not.toBeNull();
    expect(pendingEmails(target)).toEqual([]);
  });

  it("keeps the confirmed row but says so when the server saved the invite and the email did not send", async () => {
    const company = companyApi({
      invite: async () => ({
        ok: true,
        value: {
          membership: { membershipKey: "email:kade@hikerhunger.com#cmp_acme", inviteeEmail: "kade@hikerhunger.com", role: "member" },
          emailSent: false,
          emailError: "Resend 403",
        },
      }),
    });
    const target = render({ slug: "acme-invite-no-email", companyUid: "cmp_acme", company });
    await ready(target);

    openSheetAndType(target, "kade@hikerhunger.com");
    send(target);

    await vi.waitFor(() => {
      flushSync();
      expect(pendingEmails(target)).toEqual(["kade@hikerhunger.com"]);
    });
    const note = target.querySelector("[data-testid='team-action-note']")?.textContent ?? "";
    expect(note).toContain("kade@hikerhunger.com");
    expect(note.toLowerCase()).toContain("email");
    expect(note).not.toContain("Resend 403");
  });

  it("the roster read after an invite shows exactly the server's pending invites", async () => {
    let serverPending: Pending = [];
    const company = companyApi({
      pending: () => serverPending,
      invite: async () => {
        serverPending = [
          { membershipKey: "email:kade@hikerhunger.com#cmp_acme", inviteeEmail: "kade@hikerhunger.com", role: "member", invitedAt: new Date().toISOString() },
        ];
        return {
          ok: true,
          value: {
            membership: { membershipKey: "email:kade@hikerhunger.com#cmp_acme", inviteeEmail: "kade@hikerhunger.com", role: "member" },
            emailSent: true,
          },
        };
      },
    });
    const first = render({ slug: "acme-invite-refresh", companyUid: "cmp_acme", company });
    await ready(first);
    openSheetAndType(first, "kade@hikerhunger.com");
    send(first);
    await vi.waitFor(() => {
      flushSync();
      expect(pendingEmails(first)).toEqual(["kade@hikerhunger.com"]);
    });
    unmount(mounted.pop()!);
    document.body.innerHTML = "";

    // Coming back to the page re-reads the roster: the confirmed invite stays.
    const second = render({ slug: "acme-invite-refresh", companyUid: "cmp_acme", company });
    await vi.waitFor(() => {
      flushSync();
      expect(company.listPendingMemberships).toHaveBeenCalledTimes(2);
      expect(pendingEmails(second)).toEqual(["kade@hikerhunger.com"]);
    });

    // When the server no longer has it (revoked elsewhere), the read clears it.
    serverPending = [];
    unmount(mounted.pop()!);
    document.body.innerHTML = "";
    const third = render({ slug: "acme-invite-refresh", companyUid: "cmp_acme", company });
    await vi.waitFor(() => {
      flushSync();
      expect(company.listPendingMemberships).toHaveBeenCalledTimes(3);
      expect(pendingEmails(third)).toEqual([]);
    });
  });

  it("a stale local-only invite in the cache is cleared by a fresh pending read with no invites", async () => {
    writeTeamCache("acme-invite-stale", {
      view: { members: [], humans: [], agents: [], error: null, empty: true },
      invites: [
        { id: "inv-kade@hikerhunger.com", email: "kade@hikerhunger.com", role: "member", prefixes: [], groups: [], sentLabel: "just now", sentBy: "you" },
      ],
    });
    const company = companyApi({ pending: () => [] });
    const target = render({ slug: "acme-invite-stale", companyUid: "cmp_acme", company });
    await vi.waitFor(() => {
      flushSync();
      expect(company.listPendingMemberships).toHaveBeenCalled();
      expect(pendingEmails(target)).toEqual([]);
    });
  });
});
