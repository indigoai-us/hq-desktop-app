// @vitest-environment happy-dom

// PL-04 — white-label brand slot in the desktop window's header. Entitled
// companies replace the HQ wordmark with their logo plus the permanent
// powered-by lockup; everyone else keeps the chrome they had.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import V4TitleBar from "./V4TitleBar.svelte";
import type { CachedBrand } from "../brand/brand.js";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function adapter() {
  return {
    kind: "desktop" as const,
    capabilities: { hasWindowControls: true, localFiles: true },
    isAvailable: () => false,
    shell: { detectAiTools: vi.fn(async () => ok({})) },
    files: { revealHqRoot: vi.fn(async () => ok(undefined)) },
    settings: {
      getSetupStatus: vi.fn(async () => ok({ hqFolderPath: "/tmp/HQ" })),
    },
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function mountBar(extraProps: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(V4TitleBar, {
    target: host,
    props: {
      adapter: adapter(),
      version: "0.0.0-test",
      syncState: "idle",
      watchedCount: 0,
      ...extraProps,
    } as never,
  });
  await tick();
}

function brand(overrides: Partial<CachedBrand> = {}): CachedBrand {
  return {
    brandingEnabled: true,
    brand: {
      logoUrlLight: "https://cdn.example.com/acme-light.png",
      logoUrlDark: "https://cdn.example.com/acme-dark.png",
      accentColor: "#5b21b6",
    },
    companySlug: "acme",
    companyUid: "cmp_acme",
    logoDataLight: null,
    logoDataDark: null,
    cachedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("titlebar brand slot", () => {
  it("shows the tenant logo and the powered-by lockup for an entitled company", async () => {
    await mountBar({ brand: brand(), brandCompanyName: "Acme" });

    const slot = host.querySelector('[data-testid="titlebar-brand-slot"]');
    expect(slot, "entitled company gets the brand slot").toBeTruthy();

    const logo = host.querySelector<HTMLImageElement>(
      '[data-testid="brand-tenant-logo"]',
    );
    // happy-dom reports a light appearance, so the light variant is the
    // one the slot must resolve.
    expect(logo?.getAttribute("src")).toBe(
      "https://cdn.example.com/acme-light.png",
    );
    expect(logo?.getAttribute("alt")).toBe("Acme");
    expect(
      host.querySelector('[data-testid="powered-by-hq"]'),
      "the lockup is not removable while branding is active",
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="titlebar-wordmark"]'),
      "the HQ wordmark yields to the tenant logo",
    ).toBeNull();
  });

  it("leaves the chrome untouched with no brand at all", async () => {
    await mountBar({});
    expect(host.querySelector('[data-testid="titlebar-brand-slot"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="titlebar-wordmark"]')?.textContent,
    ).toBe("HQ");
  });

  it("leaves the chrome untouched when the entitlement is absent", async () => {
    // Brand values can arrive without the entitlement stamp; that is not a
    // licence to white-label the window.
    await mountBar({
      brand: brand({ brandingEnabled: false as unknown as true }),
      brandCompanyName: "Acme",
    });
    expect(host.querySelector('[data-testid="titlebar-brand-slot"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="titlebar-wordmark"]')?.textContent,
    ).toBe("HQ");
  });

  it("leaves the chrome untouched when an entitled company set no brand fields", async () => {
    await mountBar({
      brand: brand({ brand: {} }),
      brandCompanyName: "Acme",
    });
    expect(host.querySelector('[data-testid="titlebar-brand-slot"]')).toBeNull();
  });

  it("renders the cached data URL so an offline launch keeps the logo", async () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    await mountBar({
      brand: brand({ logoDataLight: dataUrl }),
      brandCompanyName: "Acme",
    });
    expect(
      host
        .querySelector<HTMLImageElement>('[data-testid="brand-tenant-logo"]')
        ?.getAttribute("src"),
    ).toBe(dataUrl);
  });
});
