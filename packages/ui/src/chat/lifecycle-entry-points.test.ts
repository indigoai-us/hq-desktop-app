// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import {
  findLifecycleCardElement,
  runAddAgentEntry,
  runCreateCompanyEntry,
} from "./lifecycle-entry-points.js";
import type { CardActionResult } from "./chat-api.js";

const done = (extra: Partial<CardActionResult> = {}): CardActionResult => ({
  cardId: "x",
  actionId: "y",
  state: "done",
  ...extra,
});

describe("runCreateCompanyEntry", () => {
  it("runs the #setup summary action and lands on the posted card", async () => {
    const runCardAction = vi.fn(async () =>
      done({ cardId: "card_create_company_2", channelId: "setup", state: "open" }),
    );
    const result = await runCreateCompanyEntry({ runCardAction });
    expect(runCardAction).toHaveBeenCalledWith({
      channelId: "setup",
      cardId: "companies_summary",
      actionId: "create_company",
      values: {},
      idempotencyKey: undefined,
    });
    expect(result).toEqual({
      ok: true,
      target: {
        channelId: "setup",
        cardId: "card_create_company_2",
        cardKind: "create_company",
      },
    });
  });

  it("falls back to the seeded create_company card when the summary 404s", async () => {
    const runCardAction = vi.fn(async () => {
      throw new Error("[not_found] Request failed (status 404)");
    });
    const result = await runCreateCompanyEntry({ runCardAction });
    expect(result).toEqual({
      ok: true,
      target: { channelId: "setup", cardId: null, cardKind: "create_company" },
    });
  });

  it("surfaces other failures as an inline reason", async () => {
    const runCardAction = vi.fn(async () => {
      throw new Error("[forbidden] Only owners can create companies");
    });
    const result = await runCreateCompanyEntry({ runCardAction });
    expect(result).toEqual({
      ok: false,
      reason: "Only owners can create companies",
      blocked: true,
    });
  });
});

describe("runAddAgentEntry", () => {
  it("runs the Team tab spend-row action and lands on the returned card", async () => {
    const runCompanyTabAction = vi.fn(async () =>
      done({ cardId: "card_create_agent_1", channelId: "chn_ramen_bae", state: "open" }),
    );
    const result = await runAddAgentEntry(
      { runCardAction: vi.fn(), runCompanyTabAction },
      "cmp_ramen_bae",
    );
    expect(runCompanyTabAction).toHaveBeenCalledWith({
      companyUid: "cmp_ramen_bae",
      tab: "team",
      cardId: "team:spend",
      actionId: "add_agent",
      values: {},
      idempotencyKey: undefined,
    });
    expect(result).toEqual({
      ok: true,
      target: {
        channelId: "chn_ramen_bae",
        cardId: "card_create_agent_1",
        cardKind: null,
      },
    });
  });

  it("reports a blocked permission result inline", async () => {
    const runCompanyTabAction = vi.fn(async () =>
      done({
        cardId: "team:spend",
        state: "blocked",
        reason: "Only owners can add agents.",
      }),
    );
    const result = await runAddAgentEntry(
      { runCardAction: vi.fn(), runCompanyTabAction },
      "cmp_ramen_bae",
    );
    expect(result).toEqual({
      ok: false,
      reason: "Only owners can add agents.",
      blocked: true,
    });
  });

  it("treats a thrown forbidden error as blocked and strips the code", async () => {
    const runCompanyTabAction = vi.fn(async () => {
      throw new Error("[forbidden] Only owners can change this");
    });
    const result = await runAddAgentEntry(
      { runCardAction: vi.fn(), runCompanyTabAction },
      "cmp_ramen_bae",
    );
    expect(result).toEqual({
      ok: false,
      reason: "Only owners can change this",
      blocked: true,
    });
  });

  it("refuses without a company or without the tab seam", async () => {
    const api = { runCardAction: vi.fn(), runCompanyTabAction: vi.fn() };
    expect((await runAddAgentEntry(api, "  ")).ok).toBe(false);
    expect(
      (await runAddAgentEntry({ runCardAction: vi.fn() }, "cmp_x")).ok,
    ).toBe(false);
    expect(api.runCompanyTabAction).not.toHaveBeenCalled();
  });
});

describe("findLifecycleCardElement", () => {
  it("prefers the card id, then the newest live card of the kind", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <article data-testid="lifecycle-card" data-card-id="a" data-card-kind="create_company" data-state="done"></article>
      <article data-testid="lifecycle-card" data-card-id="b" data-card-kind="create_company" data-state="open"></article>
      <article data-testid="lifecycle-card" data-card-id="c" data-card-kind="status" data-state="open"></article>
    `;
    expect(
      findLifecycleCardElement(root, { cardId: "c", cardKind: null })?.dataset
        .cardId,
    ).toBe("c");
    expect(
      findLifecycleCardElement(root, { cardId: "zzz", cardKind: "create_company" })
        ?.dataset.cardId,
    ).toBe("b");
    expect(
      findLifecycleCardElement(root, { cardId: null, cardKind: "nope" }),
    ).toBeNull();
  });
});
