import { describe, expect, it } from "vitest";
import { AVATAR_HUES, avatarFace, avatarHue, avatarInitials, BOT_GLYPH } from "./avatar.js";

const PHOTO = "data:image/png;base64,AAAA";
const MASCOTS = ["/assets/agent-01.jpg", "/assets/agent-02.jpg", "/assets/agent-03.jpg"];

describe("avatar fallback order", () => {
  it("shows the photo first, for people and bots", () => {
    expect(avatarFace({ kind: "person", name: "Ada Lovelace", id: "prs_ada", photo: PHOTO })).toEqual({
      type: "photo",
      src: PHOTO,
    });
    expect(avatarFace({ kind: "bot", name: "Izzy", id: "agt_izzy", photo: PHOTO, mascots: MASCOTS })).toEqual({
      type: "photo",
      src: PHOTO,
    });
  });

  it("gives a bot without a photo its mascot art, never initials", () => {
    const face = avatarFace({ kind: "bot", name: "Izzy", id: "agt_izzy", mascots: MASCOTS });
    expect(face.type).toBe("mascot");
    expect(MASCOTS).toContain((face as { src: string }).src);
    // Same bot, same mascot.
    expect(avatarFace({ kind: "bot", name: "Izzy", id: "agt_izzy", mascots: MASCOTS })).toEqual(face);
    // No art bundled at all: a glyph, still not initials.
    expect(avatarFace({ kind: "bot", name: "Izzy", id: "agt_izzy", mascots: [] })).toEqual({
      type: "glyph",
      text: BOT_GLYPH,
    });
  });

  it("gives a person without a photo colored initials", () => {
    const face = avatarFace({ kind: "person", name: "Hassaan Saleem", id: "prs_hs", mascots: MASCOTS });
    expect(face).toEqual({ type: "initials", text: "HS", hue: avatarHue("prs_hs") });
  });

  it("ignores a photo URL the packaged app could not paint", () => {
    const face = avatarFace({ kind: "person", name: "Ada", id: "prs_ada", photo: "https://tracker.example.com/a.png" });
    expect(face.type).toBe("initials");
  });
});

describe("avatar color", () => {
  it("is the same for the same id, every time", () => {
    expect(avatarHue("prs_01KQ2TZQMA8078CHPDWBAFPN0Z")).toBe(avatarHue("prs_01KQ2TZQMA8078CHPDWBAFPN0Z"));
    expect(avatarHue("PRS_abc")).toBe(avatarHue("prs_abc"));
  });

  it("always comes from the palette and spreads across it", () => {
    const hues = new Set(Array.from({ length: 200 }, (_, i) => avatarHue(`prs_${i}`)));
    for (const hue of hues) expect(AVATAR_HUES).toContain(hue);
    expect(hues.size).toBeGreaterThanOrEqual(AVATAR_HUES.length - 1);
  });

  it("leaves indigo and purple out of the palette", () => {
    for (const hue of AVATAR_HUES) expect(hue >= 240 && hue <= 300).toBe(false);
  });
});

describe("avatar initials", () => {
  it("takes two letters from a name or an email", () => {
    expect(avatarInitials("Hassaan Saleem")).toBe("HS");
    expect(avatarInitials("corey.epstein@getindigo.ai")).toBe("CE");
    expect(avatarInitials("Lin")).toBe("LI");
    expect(avatarInitials("")).toBe("?");
  });
});
