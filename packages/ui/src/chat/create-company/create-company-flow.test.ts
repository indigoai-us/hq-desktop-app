/**
 * The headless driver behind the modal's company step: open the server's
 * `create_company` card, submit it, send the invites.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CREATE_COMPANY_CLOUD_FAILED_REASON,
  CREATE_COMPANY_CLOUD_UNAVAILABLE_REASON,
  CREATE_COMPANY_NO_ACTION_REASON,
  CREATE_COMPANY_NO_CARD_REASON,
  CREATE_COMPANY_NO_RESULT_REASON,
  openCreateCompanyDraft,
  provisionCompanyCloud,
  sendCompanyInvites,
  submitCreateCompany,
  type CompanyDraftForm,
} from "./create-company-flow.js";

const NAME_FIELD = {
  id: "name",
  label: "Company name",
  control: "text",
  required: true,
  value: "",
  hint: "Shown in the sidebar and on invites.",
};

function card(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: "lifecycle_card",
    kind: "create_company",
    cardId: "card_create_company_2",
    state: "open",
    title: "Name your company",
    summary: "This creates the company channel, vault, and team roster.",
    fields: [NAME_FIELD, { id: "slug", label: "Company address", control: "text", value: "acme" }],
    actions: [{ id: "submit", label: "Create company", style: "primary" }],
    viewer: { canAct: true },
    ...overrides,
  };
}

/** A newest-first page, the way `fetch_channel` answers. */
function page(cards: Array<Record<string, unknown>>) {
  return {
    channelId: "setup",
    messages: cards.map((systemEvent, i) => ({
      eventId: `evt_${i}`,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      messageKind: "system",
      systemEvent,
    })),
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return {
    runCardAction: vi.fn(async () => ({
      cardId: "card_create_company_2",
      actionId: "create_company",
      state: "open",
      channelId: "setup",
    })),
    fetchChannel: vi.fn(async () => page([card()])),
    activateCompanyCloud: vi.fn(async () => ({ alreadyActivated: false })),
    ...overrides,
  } as never;
}

const noWait = { sleep: async () => {}, pollMs: 0 };

describe("openCreateCompanyDraft", () => {
  it("returns the fields the server's own card declares", async () => {
    const result = await openCreateCompanyDraft(api(), noWait);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.cardId).toBe("card_create_company_2");
    expect(result.form.actionId).toBe("submit");
    expect(result.form.nameFieldId).toBe("name");
    expect(result.form.fields.map((f) => f.id)).toEqual(["name", "slug"]);
    expect(result.form.fields[1]?.value).toBe("acme");
  });

  it("reads the seeded card when the account has no summary card yet", async () => {
    const seam = api({
      runCardAction: vi.fn(async () => {
        throw new Error("[not_found] Request failed (status 404)");
      }),
      fetchChannel: vi.fn(async () => page([card({ cardId: "card_create_company" })])),
    });
    const result = await openCreateCompanyDraft(seam, noWait);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.form.cardId).toBe("card_create_company");
  });

  it("keeps the server's refusal", async () => {
    const seam = api({
      runCardAction: vi.fn(async () => ({
        cardId: "companies_summary",
        actionId: "create_company",
        state: "blocked",
        reason: "Only owners can add a company",
      })),
    });
    const result = await openCreateCompanyDraft(seam, noWait);
    expect(result).toEqual({
      ok: false,
      reason: "Only owners can add a company",
      blocked: true,
    });
  });

  it("refuses a card this viewer cannot act on", async () => {
    const seam = api({
      fetchChannel: vi.fn(async () => page([card({ viewer: { canAct: false } })])),
    });
    const result = await openCreateCompanyDraft(seam, noWait);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toBe(true);
  });

  it("says so when the card never arrives", async () => {
    const seam = api({ fetchChannel: vi.fn(async () => page([])) });
    const result = await openCreateCompanyDraft(seam, { ...noWait, pollAttempts: 2 });
    expect(result).toEqual({
      ok: false,
      reason: CREATE_COMPANY_NO_CARD_REASON,
      blocked: false,
    });
  });

  it("says so when the card carries no button it can press", async () => {
    const seam = api({
      fetchChannel: vi.fn(async () =>
        page([card({ actions: [{ id: "docs", label: "Read more", style: "secondary", href: "https://hq" }] })]),
      ),
    });
    const result = await openCreateCompanyDraft(seam, noWait);
    expect(result).toEqual({
      ok: false,
      reason: CREATE_COMPANY_NO_ACTION_REASON,
      blocked: false,
    });
  });

  it("reports a transport failure with the server's words", async () => {
    const seam = api({
      runCardAction: vi.fn(async () => {
        throw new Error("[network] Request failed (status 503)");
      }),
    });
    const result = await openCreateCompanyDraft(seam, noWait);
    expect(result).toEqual({
      ok: false,
      reason: "Request failed (status 503)",
      blocked: false,
    });
  });
});

const FORM: CompanyDraftForm = {
  channelId: "setup",
  cardId: "card_create_company_2",
  title: "Name your company",
  summary: null,
  actionId: "submit",
  nameFieldId: "name",
  fields: [],
};

describe("submitCreateCompany", () => {
  it("runs the card's action and hands back the company the server made", async () => {
    const runCardAction = vi.fn(async () => ({
      cardId: "card_create_company_2",
      actionId: "submit",
      state: "done",
      companyUid: "cmp_acme",
      companyChannelId: "chn_acme",
    }));
    const seam = api({ runCardAction });
    const result = await submitCreateCompany(seam, FORM, { name: "Acme", slug: "acme" });
    expect(runCardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "setup",
        cardId: "card_create_company_2",
        actionId: "submit",
        values: { name: "Acme", slug: "acme" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      company: { companyUid: "cmp_acme", companyChannelId: "chn_acme", inviteFailures: [], cloudError: null },
    });
  });

  it("does not create a channel of its own — the server mints it", async () => {
    const seam = api({
      runCardAction: vi.fn(async () => ({
        cardId: "card_create_company_2",
        actionId: "submit",
        state: "done",
        companyUid: "cmp_acme",
        companyChannelId: "chn_acme",
      })),
    });
    await submitCreateCompany(seam, FORM, { name: "Acme" });
    expect((seam as { createChannel?: unknown }).createChannel).toBeUndefined();
  });

  it("keeps a refusal the card recorded but the answer left out", async () => {
    const seam = api({
      runCardAction: vi.fn(async () => ({
        cardId: "card_create_company_2",
        actionId: "submit",
        state: "blocked",
      })),
      fetchChannel: vi.fn(async () =>
        page([card({ state: "blocked", reason: "The handle acme is already taken." })]),
      ),
    });
    const result = await submitCreateCompany(seam, FORM, { name: "Acme" });
    expect(result).toEqual({
      ok: false,
      reason: "The handle acme is already taken.",
      blocked: true,
    });
  });

  it("never claims success when the server named nothing it made", async () => {
    const seam = api({
      runCardAction: vi.fn(async () => ({
        cardId: "card_create_company_2",
        actionId: "submit",
        state: "done",
      })),
    });
    const result = await submitCreateCompany(seam, FORM, { name: "Acme" });
    expect(result).toEqual({
      ok: false,
      reason: CREATE_COMPANY_NO_RESULT_REASON,
      blocked: false,
    });
  });

  it("sends one team invite per address after the company exists", async () => {
    const runCompanyTabAction = vi.fn(async () => ({
      cardId: "team:invite",
      actionId: "invite",
      state: "done",
    }));
    const seam = api({
      runCardAction: vi.fn(async () => ({
        cardId: "card_create_company_2",
        actionId: "submit",
        state: "done",
        companyUid: "cmp_acme",
        companyChannelId: "chn_acme",
      })),
      runCompanyTabAction,
    });
    const result = await submitCreateCompany(seam, FORM, { name: "Acme" }, [
      { email: "ada@example.com", role: "owner" },
      { email: "grace@example.com", role: "member" },
    ]);
    expect(result.ok).toBe(true);
    expect(runCompanyTabAction).toHaveBeenCalledTimes(2);
    expect(runCompanyTabAction).toHaveBeenNthCalledWith(1, {
      companyUid: "cmp_acme",
      tab: "team",
      cardId: "team:invite",
      actionId: "invite",
      values: { email: "ada@example.com", role: "owner", inviteSurface: "desktop" },
    });
  });
});

describe("sendCompanyInvites", () => {
  it("collects a refusal and keeps going", async () => {
    const runCompanyTabAction = vi.fn(async ({ values }: { values: Record<string, string> }) =>
      values.email === "ada@example.com"
        ? { cardId: "team:invite", actionId: "invite", state: "blocked", reason: "Already a member." }
        : { cardId: "team:invite", actionId: "invite", state: "done" },
    );
    const failures = await sendCompanyInvites(api({ runCompanyTabAction }), "cmp_acme", [
      { email: "ada@example.com", role: "member" },
      { email: "grace@example.com", role: "member" },
    ]);
    expect(runCompanyTabAction).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([{ email: "ada@example.com", reason: "Already a member." }]);
  });

  it("reports a throw instead of swallowing it", async () => {
    const failures = await sendCompanyInvites(
      api({
        runCompanyTabAction: vi.fn(async () => {
          throw new Error("[rate_limit] Too many invites");
        }),
      }),
      "cmp_acme",
      [{ email: "ada@example.com", role: "member" }],
    );
    expect(failures).toEqual([{ email: "ada@example.com", reason: "Too many invites" }]);
  });

  it("says plainly when the host cannot invite at all", async () => {
    const failures = await sendCompanyInvites(api(), "cmp_acme", [
      { email: "ada@example.com", role: "member" },
    ]);
    expect(failures).toEqual([
      { email: "ada@example.com", reason: "Inviting people isn't available in this build." },
    ]);
  });
});

describe("cloud provisioning after create", () => {
  const done = vi.fn(async () => ({
    cardId: "card_create_company_2",
    actionId: "submit",
    state: "done",
    companyUid: "cmp_acme",
    companyChannelId: "chn_acme",
  }));

  it("provisions the new company's cloud vault before reporting it ready", async () => {
    const order: string[] = [];
    const activateCompanyCloud = vi.fn(async (uid: string) => {
      order.push(`activate:${uid}`);
      return { alreadyActivated: false };
    });
    const runCompanyTabAction = vi.fn(async () => {
      order.push("invite");
      return { state: "done" };
    });
    const phases: string[] = [];
    const result = await submitCreateCompany(
      api({ runCardAction: done, activateCompanyCloud, runCompanyTabAction }),
      FORM,
      { name: "Acme" },
      [{ email: "ada@example.com", role: "member" }],
      { onPhase: (phase) => phases.push(phase) },
    );
    expect(activateCompanyCloud).toHaveBeenCalledWith("cmp_acme");
    expect(order).toEqual(["activate:cmp_acme", "invite"]);
    expect(phases).toEqual(["provisioning", "inviting"]);
    expect(result.ok && result.company.cloudError).toBeNull();
  });

  it("retries a transient failure, then reports the company as created but not provisioned", async () => {
    const activateCompanyCloud = vi.fn(async () => {
      throw new Error("Request failed (status 502)");
    });
    const result = await submitCreateCompany(
      api({ runCardAction: done, activateCompanyCloud }),
      FORM,
      { name: "Acme" },
      [],
      { sleep: async () => {}, provisionAttempts: 3 },
    );
    expect(activateCompanyCloud).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      ok: true,
      company: {
        companyUid: "cmp_acme",
        companyChannelId: "chn_acme",
        inviteFailures: [],
        cloudError: CREATE_COMPANY_CLOUD_FAILED_REASON,
      },
    });
  });

  it("does not retry a refusal", async () => {
    const activateCompanyCloud = vi.fn(async () => {
      throw new Error("Request failed (status 403)");
    });
    const result = await provisionCompanyCloud({ activateCompanyCloud }, "cmp_acme", {
      sleep: async () => {},
    });
    expect(activateCompanyCloud).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: CREATE_COMPANY_CLOUD_FAILED_REASON });
  });

  it("says so when the host cannot provision at all", async () => {
    const result = await provisionCompanyCloud({}, "cmp_acme");
    expect(result).toEqual({ ok: false, reason: CREATE_COMPANY_CLOUD_UNAVAILABLE_REASON });
  });

  it("treats an already-provisioned company as success, so Try again is safe", async () => {
    const activateCompanyCloud = vi.fn(async () => ({ alreadyActivated: true }));
    expect(await provisionCompanyCloud({ activateCompanyCloud }, "cmp_acme")).toEqual({
      ok: true,
    });
  });
});
