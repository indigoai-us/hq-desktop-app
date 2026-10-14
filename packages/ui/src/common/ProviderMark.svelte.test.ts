// @vitest-environment happy-dom

// Provider marks: every chart provider has a mark, unknown providers fall back
// to the neutral disc, and the mark renders at 14px with an accessible name.
import { flushSync, mount, unmount } from "svelte";
import { siAnthropic } from "simple-icons";
import { describe, expect, it } from "vitest";
import { VIZ_SLOTS } from "../telemetry/telemetry-colors";
import ProviderMark from "./ProviderMark.svelte";
import { PROVIDER_MARKS, providerMark } from "./provider-marks";

describe("provider marks", () => {
  it("has a distinct mark for each provider the chart colors", () => {
    const providers = [...new Set(VIZ_SLOTS.map((s) => s.provider))];
    for (const p of providers) expect(PROVIDER_MARKS[p].d, p).toMatch(/^M/);
    expect(new Set(providers.map((p) => PROVIDER_MARKS[p].d)).size).toBe(providers.length);
    expect(PROVIDER_MARKS.anthropic.d).toBe(siAnthropic.path);
    expect(providerMark("openai").label).toBe("OpenAI");
    expect(providerMark("xai").label).toBe("xAI");
  });

  it("falls back to the neutral mark for an unknown provider", () => {
    expect(providerMark("mistral")).toBe(PROVIDER_MARKS.neutral);
    expect(providerMark("")).toBe(PROVIDER_MARKS.neutral);
  });

  it("renders a 14px tinted svg with an accessible label", () => {
    const target = document.createElement("div");
    const c = mount(ProviderMark, { target, props: { provider: "openai", color: "var(--viz-openai)", opacity: 0.5 } });
    flushSync();
    const svg = target.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("OpenAI");
    expect(svg.getAttribute("width")).toBe("14");
    expect(svg.style.color).toBe("var(--viz-openai)");
    expect(svg.style.opacity).toBe("0.5");
    unmount(c);
  });
});
