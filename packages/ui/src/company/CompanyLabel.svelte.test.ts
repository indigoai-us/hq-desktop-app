// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { MARKETPLACE_COVER_HOST } from "../avatars/csp-image-src";
import CompanyLabel from "./CompanyLabel.svelte";
import { setCompanyIconRegistry } from "./company-icon-registry.svelte";

const ICON = `https://${MARKETPLACE_COVER_HOST}/branding/cmp_acme/favicon.png?X-Amz-Signature=mock`;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function render(props: { name: string } & Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CompanyLabel, { target: host, props });
  flushSync();
  return host;
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  setCompanyIconRegistry(new Map());
});

describe("CompanyLabel", () => {
  it("shows the favicon at 14px next to the name", () => {
    render({ name: "Acme Corp", iconUrl: ICON });
    const img = host.querySelector("img.company-icon-img");
    expect(img?.getAttribute("src")).toBe(ICON);
    const mark = host.querySelector<HTMLElement>("[data-testid='company-icon']");
    expect(mark?.getAttribute("style")).toContain("--company-icon-size: 14px");
    expect(host.querySelector("[data-testid='company-label-initials']")).toBeNull();
    expect(host.querySelector(".company-label-name")?.textContent).toBe("Acme Corp");
  });

  it("falls back to an initials badge when there is no icon", () => {
    render({ name: "Acme Corp" });
    expect(host.querySelector("img")).toBeNull();
    const badge = host.querySelector("[data-testid='company-label-initials']");
    expect(badge?.textContent).toBe("AC");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(host.textContent).toContain("Acme Corp");
  });

  it("uses initials, not the image, for a url the CSP would refuse", () => {
    render({ name: "boring-ecom", iconUrl: "https://evil.example/x.png" });
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("[data-testid='company-label-initials']")?.textContent).toBe("BO");
  });

  it("finds the icon in the shared registry by company uid", () => {
    setCompanyIconRegistry(new Map([["cmp_acme", ICON]]));
    render({ name: "Acme", companyUid: "cmp_acme" });
    expect(host.querySelector("img.company-icon-img")?.getAttribute("src")).toBe(ICON);
    expect(host.textContent).not.toContain("cmp_acme");
  });

  it("finds the icon in the shared registry by display name", () => {
    setCompanyIconRegistry(new Map([["Amass", ICON]]));
    render({ name: "Amass" });
    expect(host.querySelector("img.company-icon-img")?.getAttribute("src")).toBe(ICON);
  });
});
