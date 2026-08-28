import { describe, expect, it } from "vitest";

import { safeLocalImageSrc } from "./local-image-src";

describe("safeLocalImageSrc", () => {
  it("keeps packaged relative assets and raster data returned by native previews", () => {
    expect(safeLocalImageSrc("/assets/avatar.png")).toBe("/assets/avatar.png");
    expect(safeLocalImageSrc("./avatar.webp")).toBe("./avatar.webp");
    expect(safeLocalImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("rejects remote, privileged, protocol-relative, and active SVG sources", () => {
    for (const source of [
      "https://cdn.example.com/avatar.png",
      "http://cdn.example.com/avatar.png",
      "//cdn.example.com/avatar.png",
      "\\\\cdn.example.com\\avatar.png",
      "file:///Users/me/avatar.png",
      "asset://localhost/avatar.png",
      "blob:https://app.local/id",
      'data:image/svg+xml,<svg onload="alert(1)"/>',
      "#avatar",
    ]) {
      expect(safeLocalImageSrc(source), source).toBeNull();
    }
  });
});
