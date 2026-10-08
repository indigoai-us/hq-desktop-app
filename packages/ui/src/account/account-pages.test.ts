import { describe, expect, it } from "vitest";
import {
  deleteConfirmed,
  invoicePdfUrl,
  invoiceStripeUrl,
  managePaymentUrl,
  metadata,
  paintAccount,
  recordShortcut,
  updateReady,
  aboutUpdateLine,
  autoUpdateRow,
  DEFAULT_SHORTCUTS,
} from "./account-pages.js";

describe("account pages (US-035)", () => {
  it("opens invoices and payment on the Stripe host", () => {
    expect(new URL(invoicePdfUrl("IN-2026-0009")).hostname).toBe("billing.stripe.com");
    expect(invoicePdfUrl("IN-2026-0009")).toContain(".pdf");
    expect(new URL(invoiceStripeUrl("IN-2026-0009")).hostname).toBe("billing.stripe.com");
    expect(new URL(managePaymentUrl()).hostname).toBe("billing.stripe.com");
  });

  it("requires the delete phrase before sign-in", () => {
    expect(deleteConfirmed("")).toBe(false);
    expect(deleteConfirmed("Delete")).toBe(true);
  });

  it("records a free chord and reports a conflict", () => {
    const free = recordShortcut(DEFAULT_SHORTCUTS, "atlas", "⌘⇧B");
    expect(free.conflict).toBeNull();
    expect(free.rows.find((row) => row.id === "atlas")?.keys).toBe("⌘⇧B");
    const taken = recordShortcut(DEFAULT_SHORTCUTS, "atlas", "⌘A");
    expect(taken.conflict).toContain("Select all");
  });

  it("treats a staged update as ready and paints from cache first", () => {
    expect(updateReady("ready", "available")).toBe(true);
    expect(updateReady("idle", "up-to-date")).toBe(false);
    const painted = paintAccount(null, {
      name: "Ada Lovelace",
      email: "ada@example.com",
      companies: [{ uid: "co", label: "Indigo", role: "Owner", plan: "HQ Workforce", since: "" }],
    });
    expect(painted.displayName).toBe("Ada Lovelace");
    expect(painted.invoices.length).toBeGreaterThan(0);
    expect(metadata.performanceBudget.scrollDroppedFramesPct).toBe(0.01);
  });

  it("About reads the shared update store, never claiming up to date when an update is offered (QA-051)", () => {
    const base = { installPhase: "idle", availableVersion: null, backgroundUpdatesOff: false };
    expect(aboutUpdateLine({ ...base, appStatus: "available", availableVersion: "0.10.379" })).toBe(
      "HQ 0.10.379 is available.",
    );
    expect(aboutUpdateLine({ ...base, appStatus: "up-to-date" })).toBe("HQ is up to date.");
    expect(aboutUpdateLine({ ...base, appStatus: "unchecked" })).toBe("HQ has not checked for updates yet.");
    expect(aboutUpdateLine({ ...base, appStatus: "unchecked", backgroundUpdatesOff: true })).toContain(
      "Automatic updates are off in this build",
    );
    expect(
      aboutUpdateLine({ ...base, appStatus: "available", availableVersion: "0.10.379", backgroundUpdatesOff: true }),
    ).toBe("HQ 0.10.379 is available. Automatic updates are off in this build; use Check for updates.");
  });
});

describe("autoUpdateRow (QA-061)", () => {
  it("disables the toggle and keeps the saved preference visible when the build has no updater", () => {
    const row = autoUpdateRow({ autoUpdate: true, backgroundUpdatesOff: true });
    expect(row.disabled).toBe(true);
    expect(row.checked).toBe(false);
    expect(row.description).toContain("Automatic updates are not available in this build");
    expect(row.description).toContain("Saved preference: on (will apply in a release build)");
    expect(aboutUpdateLine({ installPhase: "idle", appStatus: "unchecked", availableVersion: null, backgroundUpdatesOff: true })).toContain("off in this build");
  });

  it("reflects the saved preference when the updater is available, agreeing with About", () => {
    const on = autoUpdateRow({ autoUpdate: true, backgroundUpdatesOff: false });
    expect(on).toMatchObject({ disabled: false, checked: true });
    expect(on.description).toContain("automatically in the background");
    expect(autoUpdateRow({ autoUpdate: false, backgroundUpdatesOff: false }).checked).toBe(false);
    expect(aboutUpdateLine({ installPhase: "idle", appStatus: "unchecked", availableVersion: null, backgroundUpdatesOff: false })).not.toContain("off in this build");
  });
});
