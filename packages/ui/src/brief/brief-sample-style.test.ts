// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = () => readFileSync(resolve(process.cwd(), "src/brief/brief.css"), "utf8");
const runway = () => readFileSync(resolve(process.cwd(), "src/brief/BriefRunway.svelte"), "utf8");

describe("sample markers", () => {
  it("are quiet mono caps notes, not the orange highlight (regression: 'Sample · no live source yet' wore the terracotta pill)", () => {
    const hot = css().match(/\/\* The highlight label[\s\S]*?\{/)![0];
    expect(hot).not.toMatch(/\.sample/);
    const rule = css().match(/\.daily-brief \.peek \.sample,\n\.daily-brief \.sample-tag \{([^}]*)\}/)![1]!;
    expect(rule).toMatch(/font-family: var\(--b-code\)/);
    expect(rule).toMatch(/text-transform: uppercase/);
    expect(rule).toMatch(/background: none/);
  });

  it("the runway's provisional calendar note is plain text, not a chip", () => {
    expect(runway()).toMatch(/  \.tag \{[^}]*padding: 0;[^}]*background: none;/);
  });
});
