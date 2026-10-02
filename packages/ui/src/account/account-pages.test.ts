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
});
