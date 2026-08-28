import { describe, expect, it } from "vitest";
import {
  MESH_BODY,
  MESH_TITLE,
  meshBandsFromProgress,
  meshProgressLine,
} from "./onboarding-mesh.js";

describe("work mesh installer copy", () => {
  it("introduces the mesh, then installing / syncing", () => {
    expect(MESH_TITLE).toBe("HQ Work in Real Time");
    expect(MESH_BODY).toContain("Your team everywhere all at once.");
    expect(meshProgressLine(null)).toBe("Installing.");
    expect(
      meshProgressLine({
        phase: "chats",
        current: 12,
        total: 40,
        label: "",
      }),
    ).toBe("Syncing chats. 12/40");
  });

  it("moves from Installing. to Syncing projects to the mesh.", () => {
    const installing = meshBandsFromProgress({
      phase: "apply",
      current: 0,
      total: 0,
      label: "",
    });
    expect(installing.map((b) => b.status)).toEqual(["active", "pending"]);
    expect(installing[1]?.label).toBe("Syncing projects to the mesh.");

    const syncing = meshBandsFromProgress({
      phase: "projects",
      current: 3,
      total: 10,
      label: "",
    });
    expect(syncing.map((b) => b.status)).toEqual(["done", "active"]);
    expect(syncing[1]?.label).toBe("Syncing projects to the mesh. 3/10");
  });
});
