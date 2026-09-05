// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { MARKETPLACE_COVER_HOST } from "../avatars/csp-image-src";
import CompanyIcon from "./CompanyIcon.svelte";

const ICON = `https://${MARKETPLACE_COVER_HOST}/branding/cmp_acme/favicon.png?X-Amz-Signature=mock`;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CompanyIcon, { target: host, props });
  return host;
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("CompanyIcon", () => {
  it("paints the favicon when the server supplied one", () => {
    render({ iconUrl: ICON });
    const img = host.querySelector("img.company-icon-img");
    expect(img?.getAttribute("src")).toBe(ICON);
    expect(host.querySelector("svg.company-icon-glyph")).toBeNull();
    expect(
      host.querySelector("[data-testid='company-icon']")?.getAttribute(
        "data-company-icon",
      ),
    ).toBe("image");
  });

  it("draws the building glyph when there is no icon", () => {
    render({ iconUrl: null });
    expect(host.querySelector("img.company-icon-img")).toBeNull();
    const glyph = host.querySelector("svg.company-icon-glyph");
    expect(glyph).not.toBeNull();
    expect(
      host.querySelector("[data-testid='company-icon']")?.getAttribute(
        "data-company-icon",
      ),
    ).toBe("glyph");
  });

  it("draws the glyph for an absent iconUrl prop", () => {
    render({});
    expect(host.querySelector("svg.company-icon-glyph")).not.toBeNull();
  });

  it("falls back to the glyph when the image fails to load", async () => {
    render({ iconUrl: ICON });
    const img = host.querySelector("img.company-icon-img") as HTMLImageElement;
    expect(img).not.toBeNull();
    // A presigned object can 404 after expiry — never leave a broken image.
    img.dispatchEvent(new Event("error"));
    await tick();
    expect(host.querySelector("img.company-icon-img")).toBeNull();
    expect(host.querySelector("svg.company-icon-glyph")).not.toBeNull();
  });

  it("retries a NEW icon url after a previous one failed", async () => {
    const props = $state({ iconUrl: ICON });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CompanyIcon, { target: host, props });
    await tick();
    (host.querySelector("img.company-icon-img") as HTMLImageElement)
      .dispatchEvent(new Event("error"));
    await tick();
    expect(host.querySelector("svg.company-icon-glyph")).not.toBeNull();

    props.iconUrl = ICON.replace("favicon.png", "favicon.ico");
    await tick();
    // A fresh url must get its own chance rather than inherit the failure.
    expect(host.querySelector("img.company-icon-img")).not.toBeNull();
  });

  it("refuses a url the packaged CSP could not paint", () => {
    // hq-pro's DURABLE brand.faviconUrl is an API path on the api host, which
    // is not in img-src. Rendering it would silently show nothing, so the
    // component must fall back to the glyph instead.
    render({
      iconUrl:
        "https://hqapi.hq.computer/company-settings/brand/favicon?companyUid=cmp_acme&ext=png",
    });
    expect(host.querySelector("img.company-icon-img")).toBeNull();
    expect(host.querySelector("svg.company-icon-glyph")).not.toBeNull();
  });

  it("refuses an off-host image and a non-branding path on the assets host", () => {
    for (const url of [
      "https://tracker.example/pixel.png",
      `https://${MARKETPLACE_COVER_HOST}/members/prs_x/x.png`,
      `http://${MARKETPLACE_COVER_HOST}/branding/cmp_acme/favicon.png`,
    ]) {
      render({ iconUrl: url });
      expect(host.querySelector("img.company-icon-img")).toBeNull();
      host.remove();
    }
  });

  it("applies the requested size and is decorative by default", () => {
    render({ iconUrl: ICON, size: 24 });
    const mark = host.querySelector("[data-testid='company-icon']");
    expect(mark?.getAttribute("style")).toContain("--company-icon-size: 24px");
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("names the company when it is NOT decorative", () => {
    render({ iconUrl: ICON, label: "Acme", decorative: false });
    const mark = host.querySelector("[data-testid='company-icon']");
    expect(mark?.getAttribute("aria-hidden")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("Acme");
  });
});
