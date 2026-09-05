// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import LifecycleCard from "./LifecycleCard.svelte";
import {
  parseLifecycleCard,
  type LifecycleCardActionEvent,
  type LifecycleCardModel,
} from "./channelMessageModels.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function card(
  overrides: Record<string, unknown> = {},
): LifecycleCardModel {
  const parsed = parseLifecycleCard({
    v: 1,
    type: "lifecycle_card",
    cardId: "card_1",
    kind: "create_company",
    companyUid: null,
    state: "open",
    title: "Name your company",
    stepLabel: "Step 1 of 4",
    summary: "You'll be the owner.",
    help: "You'll be the owner.",
    fields: [
      {
        id: "name",
        label: "Company name",
        control: "text",
        required: true,
        value: "",
      },
    ],
    actions: [{ id: "submit", label: "Create Ramen Bae", style: "primary" }],
    viewer: { canAct: true },
    ...overrides,
  });
  if (!parsed) throw new Error("expected a lifecycle card");
  return parsed;
}

function mountCard(
  model: LifecycleCardModel,
  extra: Record<string, unknown> = {},
): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(LifecycleCard, {
    target: host,
    props: { model, channelId: "setup", ...extra },
  });
  return host;
}

describe("LifecycleCard controls and states", () => {
  it("renders a labelled text field, primary action, and live step label", () => {
    const root = mountCard(card());
    const input = root.querySelector("input.lc-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(root.querySelector("label")?.getAttribute("for")).toBe(input.id);
    expect(root.querySelector(".lc-k")?.textContent).toBe("Step 1 of 4");
    expect(root.querySelector(".lc-title")?.textContent).toBe(
      "Name your company",
    );
    const primary = root.querySelector(
      '[data-testid="lifecycle-action-submit"]',
    ) as HTMLButtonElement;
    expect(primary.textContent).toContain("Create Ramen Bae");
    expect(primary.classList.contains("primary")).toBe(true);
    expect(primary.getAttribute("data-size")).toBe("32");
    expect(root.querySelector(".lc-in")?.getAttribute("data-size")).toBe("32");
  });

  it("shows an inline field error", () => {
    const root = mountCard(
      card({
        fields: [
          {
            id: "slug",
            label: "Slug",
            control: "text",
            required: true,
            error: "Taken",
            hint: "taken",
          },
        ],
      }),
    );
    expect(
      root.querySelector('[data-testid="lifecycle-field-error-slug"]')
        ?.textContent,
    ).toBe("Taken");
    expect(root.querySelector(".lc-in")?.classList.contains("err")).toBe(true);
  });

  it("renders a select as a 32px segmented control", () => {
    const root = mountCard(
      card({
        kind: "create_agent",
        companyUid: "cmp_acme",
        title: "Where it runs",
        fields: [
          {
            id: "runtime",
            label: "Runtime",
            control: "select",
            value: "codex",
            options: [
              { id: "codex", label: "Codex" },
              { id: "claude", label: "Claude" },
              { id: "grok", label: "Grok" },
            ],
          },
        ],
      }),
    );
    const group = root.querySelector('[data-testid="lifecycle-select-runtime"]');
    expect(group?.getAttribute("role")).toBe("radiogroup");
    const selected = root.querySelector(
      ".lc-seg-btn.on",
    ) as HTMLButtonElement | null;
    expect(selected).not.toBeNull();
    expect(selected?.textContent).toBe("Codex");
    expect(selected?.getAttribute("aria-checked")).toBe("true");
    expect(selected?.getAttribute("data-size")).toBe("32");
  });

  it("renders radio rows with prices at 40px", () => {
    const root = mountCard(
      card({
        kind: "upgrade_plan",
        companyUid: "cmp_acme",
        title: "Choose a plan",
        fields: [
          {
            id: "plan",
            label: "Plan",
            control: "radio",
            value: "workforce",
            options: [
              {
                id: "starter",
                label: "Starter",
                description: "Up to 50 people, no agents",
                price: "Free",
              },
              {
                id: "workforce",
                label: "Workforce",
                description: "Unlimited people, agents, every integration",
                price: "$500 / mo",
              },
            ],
          },
        ],
        actions: [
          { id: "checkout", label: "Continue to checkout", style: "primary" },
          { id: "skip", label: "Stay on Starter", style: "secondary" },
        ],
      }),
    );
    const radios = root.querySelectorAll(".lc-radio");
    expect(radios).toHaveLength(2);
    expect(radios[1]?.getAttribute("data-size")).toBe("40");
    expect(getComputedStyle(radios[1]!).height).toBe("40px");
    expect(radios[1]?.textContent).toContain("Workforce");
    expect(radios[1]?.textContent).toContain("$500 / mo");
    expect(
      root.querySelector('[data-testid="lifecycle-action-skip"]')
        ?.classList.contains("ghost"),
    ).toBe(true);
  });

  it("renders readonly rows at 36px", () => {
    const root = mountCard(
      card({
        kind: "activate_cloud",
        companyUid: "cmp_acme",
        title: "Turning on cloud sync",
        state: "pending",
        fields: [
          {
            id: "vault",
            label: "Cloud vault created",
            control: "readonly",
            value: "just now",
          },
        ],
        actions: [],
      }),
    );
    const row = root.querySelector(".lc-ro") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute("data-size")).toBe("36");
    expect(getComputedStyle(row).height).toBe("36px");
    expect(
      root.querySelector('[data-testid="lifecycle-card-status"]')?.textContent,
    ).toContain("Pending");
    expect(root.querySelector(".lc-spin")).not.toBeNull();
  });

  it("opens link actions via onopenurl and does not underline them", async () => {
    const onopenurl = vi.fn();
    const root = mountCard(
      card({
        kind: "upgrade_plan",
        companyUid: "cmp_acme",
        actions: [
          {
            id: "enterprise",
            label: "Talk to us",
            style: "link",
            href: "https://hqforwork.com/enterprise",
          },
        ],
      }),
      { onopenurl },
    );
    const link = root.querySelector(
      '[data-testid="lifecycle-action-enterprise"]',
    ) as HTMLButtonElement;
    expect(getComputedStyle(link).textDecorationLine === "underline").toBe(
      false,
    );
    expect(link.getAttribute("data-size")).toBe("28");
    link.click();
    await tick();
    expect(onopenurl).toHaveBeenCalledWith("https://hqforwork.com/enterprise");
  });

  it("without onopenurl, only http(s) link hrefs fall back to window.open", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      const root = mountCard(
        card({
          kind: "upgrade_plan",
          companyUid: "cmp_acme",
          actions: [
            {
              id: "evil",
              label: "Run",
              style: "link",
              href: "javascript:alert(1)",
            },
            {
              id: "file",
              label: "Open file",
              style: "link",
              href: "file:///etc/passwd",
            },
            {
              id: "site",
              label: "Talk to us",
              style: "link",
              href: "https://hqforwork.com/enterprise",
            },
          ],
        }),
      );
      for (const id of ["evil", "file"]) {
        (
          root.querySelector(
            `[data-testid="lifecycle-action-${id}"]`,
          ) as HTMLButtonElement
        ).click();
        await tick();
      }
      expect(open).not.toHaveBeenCalled();

      (
        root.querySelector(
          '[data-testid="lifecycle-action-site"]',
        ) as HTMLButtonElement
      ).click();
      await tick();
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(
        "https://hqforwork.com/enterprise",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      open.mockRestore();
    }
  });

  it("fires oncardaction and shows pending until the next model refresh", async () => {
    const oncardaction = vi.fn();
    const model = card({
      fields: [
        {
          id: "name",
          label: "Company name",
          control: "text",
          required: true,
          value: "Ramen Bae",
        },
      ],
    });
    const root = mountCard(model, { oncardaction });
    flushSync();
    root
      .querySelector<HTMLButtonElement>(
        '[data-testid="lifecycle-action-submit"]',
      )
      ?.click();
    flushSync();
    expect(oncardaction).toHaveBeenCalledTimes(1);
    const event = oncardaction.mock.calls[0][0] as LifecycleCardActionEvent;
    expect(event).toEqual({
      channelId: "setup",
      cardId: "card_1",
      actionId: "submit",
      values: { name: "Ramen Bae" },
    });
    expect(root.querySelector("[data-testid='lifecycle-card']")?.getAttribute("data-state")).toBe(
      "pending",
    );
    expect(root.querySelector(".lc-spin")).not.toBeNull();
    const cardEl = root.querySelector(
      "[data-testid='lifecycle-card']",
    ) as HTMLElement;
    expect(cardEl.getAttribute("tabindex")).toBe("-1");
  });

  it("submits a single-field card on Enter", async () => {
    const oncardaction = vi.fn();
    const root = mountCard(card(), { oncardaction });
    const input = root.querySelector("input.lc-input") as HTMLInputElement;
    input.value = "Ramen Bae";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    flushSync();
    expect(oncardaction).toHaveBeenCalledTimes(1);
    expect(oncardaction.mock.calls[0][0].values.name).toBe("Ramen Bae");
  });

  it("disables controls and shows the block reason", () => {
    const root = mountCard(
      card({
        state: "blocked",
        reason: "Agents come with Workforce.",
        statusLabel: "Needs Workforce",
      }),
    );
    expect(
      root.querySelector("[data-testid='lifecycle-card-reason']")?.textContent,
    ).toBe("Agents come with Workforce.");
    const submit = root.querySelector(
      '[data-testid="lifecycle-action-submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(root.querySelector("input")?.disabled ?? true).toBe(true);
  });

  it("renders read-only copy and Ask Corey when viewer.canAct is false", () => {
    const root = mountCard(
      card({
        viewer: { canAct: false, actorName: "Corey Epstein" },
      }),
    );
    expect(root.querySelector("input")).toBeNull();
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("[data-testid='lifecycle-action-submit']")).toBeNull();
    expect(
      root.querySelector("[data-testid='lifecycle-card-ask']")?.textContent,
    ).toBe("Ask Corey");
    expect(root.querySelector(".lc-title")?.textContent).toBe(
      "Name your company",
    );
  });

  it("collapses done and skipped cards to a title plus mono status", () => {
    const done = mountCard(
      card({
        state: "done",
        statusLabel: "Polar · @polar",
        stepLabel: "Step 4 of 4",
      }),
    );
    expect(done.querySelector(".lc-title")?.textContent).toBe(
      "Name your company",
    );
    expect(done.querySelector("[data-testid='lifecycle-card-status']")?.textContent).toContain(
      "Polar · @polar",
    );
    expect(done.querySelector(".lc-k")).toBeNull();
    expect(done.querySelector("input")).toBeNull();
    expect(done.querySelector(".lc-check")).not.toBeNull();
    if (component) void unmount(component);
    component = null;
    host.remove();
    const skipped = mountCard(card({ state: "skipped", stepLabel: "Step 3 of 4" }));
    expect(
      skipped.querySelector("[data-testid='lifecycle-card-status']")?.textContent,
    ).toContain("Skipped");
    expect(skipped.querySelector(".lc-k")).toBeNull();
  });

  it("locks control scale in CSS: 32 / 28 / 40 / 36", () => {
    const css = readFileSync(
      resolve("src/chat/messaging/LifecycleCard.svelte"),
      "utf8",
    );
    expect(css).toMatch(/\.lc-in \{[\s\S]*?height: 32px;/);
    expect(css).toMatch(/\.lc-seg-btn \{[\s\S]*?height: 32px;/);
    expect(css).toMatch(/\.lc-btn \{[\s\S]*?height: 32px;/);
    expect(css).toMatch(/\.lc-btn\.link,[\s\S]*?height: 28px;/);
    expect(css).toMatch(/\.lc-radio \{[\s\S]*?height: 40px;/);
    expect(css).toMatch(/\.lc-ro \{[\s\S]*?height: 36px;/);
    expect(css).toMatch(/text-decoration: none;/);
  });
});

describe("LifecycleCard readonly timestamps", () => {
  it("renders ISO readonly values as local time and keeps the raw stamp in title", () => {
    const stamp = new Date(2020, 0, 15, 14, 24, 0).toISOString();
    const model = card({
      kind: "status",
      companyUid: "cmp_1",
      fields: [
        { id: "started", label: "Machine started", control: "readonly", value: stamp },
        { id: "plain", label: "Status", control: "readonly", value: "plan" },
      ],
      actions: [],
    });
    const el = mountCard(model);
    const stamped = [...el.querySelectorAll("span[title]")].find(
      (node) => node.getAttribute("title") === stamp,
    );
    expect(stamped, "raw ISO kept in title").toBeTruthy();
    expect(stamped?.textContent?.trim()).toBe("Jan 15, 2:24 PM");
    expect(el.textContent).not.toContain(stamp);
    expect(el.textContent).toContain("plan");
  });
});
