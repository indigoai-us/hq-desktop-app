import { describe, expect, it } from "vitest";

import {
  iconKindForPath,
  isProjectArtifactPath,
  vaultKeyForProjectFile,
} from "./project-files.js";

describe("isProjectArtifactPath", () => {
  it("keeps project notes and skips repos / junk", () => {
    expect(isProjectArtifactPath("prd.json")).toBe(true);
    expect(isProjectArtifactPath("brainstorm.md")).toBe(true);
    expect(isProjectArtifactPath("journal/note.md")).toBe(true);
    expect(isProjectArtifactPath("fabric-genesis.json")).toBe(false);
    expect(isProjectArtifactPath("repos/private/hq-pro")).toBe(false);
    expect(isProjectArtifactPath(".DS_Store")).toBe(false);
  });
});

describe("vaultKeyForProjectFile", () => {
  it("prefixes the project folder unless already vault-shaped", () => {
    expect(vaultKeyForProjectFile("work-mesh-testing", "prd.json")).toBe(
      "projects/work-mesh-testing/prd.json",
    );
    expect(
      vaultKeyForProjectFile(
        "work-mesh-testing",
        "projects/work-mesh-testing/prd.json",
      ),
    ).toBe("projects/work-mesh-testing/prd.json");
  });
});

describe("iconKindForPath", () => {
  it("maps markdown and json", () => {
    expect(iconKindForPath("brainstorm.md")).toBe("markdown");
    expect(iconKindForPath("prd.json")).toBe("text");
  });
});
