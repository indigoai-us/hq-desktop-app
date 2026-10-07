import { describe, expect, it, vi } from "vitest";
import { companySlugForPath, fileTreeErrorReason, withCompanyReadScope } from "./company-read-scope.js";

describe("company read scope (QA-007, QA-011)", () => {
  it("finds the company slug for company paths only", () => {
    expect(companySlugForPath("companies/indigo")).toBe("indigo");
    expect(companySlugForPath("companies/indigo/projects/x")).toBe("indigo");
    expect(companySlugForPath("companies")).toBeNull();
    expect(companySlugForPath("personal/notes")).toBeNull();
  });

  it("binds the company before the first read and once per slug", async () => {
    const order: string[] = [];
    const bind = vi.fn(async (slug: string) => {
      order.push(`bind:${slug}`);
      return { ok: true };
    });
    const list = withCompanyReadScope(bind, async (p: string) => {
      order.push(`list:${p}`);
      return p;
    });
    await list("companies/indigo");
    await list("companies/indigo/knowledge");
    await list("personal");
    expect(order).toEqual([
      "bind:indigo",
      "list:companies/indigo",
      "list:companies/indigo/knowledge",
      "list:personal",
    ]);
  });

  it("surfaces a failed bind and retries it on the next read", async () => {
    const bind = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: "company scope not bound" })
      .mockResolvedValueOnce({ ok: true });
    const list = withCompanyReadScope(bind, async (p: string) => p);
    await expect(list("companies/indigo")).rejects.toThrow("company scope not bound");
    await expect(list("companies/indigo")).resolves.toBe("companies/indigo");
    expect(bind).toHaveBeenCalledTimes(2);
  });

  it("explains failures in plain words, never the raw error", () => {
    expect(
      fileTreeErrorReason(
        new Error("company scope not bound: reading companies/indigo/ requires an active company context"),
      ),
    ).toBe("This company's files could not be opened in this window.");
    expect(fileTreeErrorReason(new Error('company files are not authorized: "x"'))).toBe(
      "You don't have access to this company's files.",
    );
    expect(fileTreeErrorReason("weird")).toBe("Could not read this folder.");
  });
});
