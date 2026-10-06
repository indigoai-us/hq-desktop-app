import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dmgDir = resolve(rootDir, "apps/sync/scripts/dmg");

let createDmg = "";
let settings = "";
let backgroundHtml = "";
let releaseWorkflow = "";
let backgroundTiff = Buffer.alloc(0);
let verifyDsStore = "";

beforeAll(async () => {
  [
    createDmg,
    settings,
    backgroundHtml,
    releaseWorkflow,
    backgroundTiff,
    verifyDsStore,
  ] = await Promise.all([
    readFile(resolve(rootDir, "apps/sync/scripts/create-dmg.sh"), "utf8"),
    readFile(resolve(dmgDir, "settings.py"), "utf8"),
    readFile(resolve(dmgDir, "background.html"), "utf8"),
    readFile(resolve(rootDir, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(dmgDir, "background.tiff")),
    readFile(resolve(dmgDir, "verify_ds_store.py"), "utf8"),
  ]);
});

/**
 * Minimal multi-page TIFF reader: walks the IFD chain and returns the pixel
 * dimensions of every page. Enough to prove the @1x and @2x representations
 * are present and correctly sized.
 */
function tiffPageSizes(buf: Buffer): Array<[number, number]> {
  const order = buf.toString("ascii", 0, 2);
  if (order !== "II" && order !== "MM") {
    throw new Error(`not a TIFF: byte order ${order}`);
  }
  const le = order === "II";
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  const pages: Array<[number, number]> = [];
  let ifd = u32(4);
  while (ifd !== 0 && pages.length < 16) {
    const count = u16(ifd);
    let width = 0;
    let height = 0;
    for (let i = 0; i < count; i += 1) {
      const entry = ifd + 2 + i * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      if (tag !== 256 && tag !== 257) continue;
      const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
      if (tag === 256) width = value;
      else height = value;
    }
    pages.push([width, height]);
    ifd = u32(ifd + 2 + count * 12);
  }
  return pages;
}

describe("DMG install-window layout contract", () => {
  // The traditional recipe styles a disk image by driving Finder over
  // AppleScript, which needs a logged-in GUI session. Release builds run on a
  // headless runner, so that approach passes locally and fails in CI. Keep the
  // packaging path free of it.
  it("never styles the disk image through Finder or AppleScript", () => {
    expect(createDmg).not.toMatch(/osascript/);
    expect(createDmg).not.toMatch(/tell\s+application\s+"Finder"/);
    expect(settings).not.toMatch(/osascript/);
  });

  it("drives dmgbuild with the committed settings, background and volume icon", () => {
    expect(createDmg).toMatch(/dmgbuild/);
    expect(createDmg).toMatch(/-s\s+"\$SETTINGS"/);
    expect(createDmg).toMatch(/-D\s+app=/);
    expect(createDmg).toMatch(/-D\s+background="\$BACKGROUND"/);
    expect(createDmg).toMatch(/-D\s+volume_icon="\$VOLUME_ICON"/);
    expect(createDmg).toMatch(/VOLUME_NAME="HQ"/);
  });

  it("pins the dmgbuild version it installs", () => {
    const pin = /DMGBUILD_VERSION="(\d+\.\d+\.\d+)"/.exec(createDmg);
    expect(pin).not.toBeNull();
    expect(createDmg).toContain('"dmgbuild==$DMGBUILD_VERSION"');
  });

  // Up to 1.6.6, dmgbuild wrote a pBBk background bookmark into the volume's
  // .DS_Store. From macOS 26.2, Finder shows a blank window when that record
  // is present, so every HQ.dmg built with 1.6.5 opened with the icons in
  // place on plain white (dmgbuild/dmgbuild#273). Never pin below the fix.
  it("pins a dmgbuild that does not break the background on macOS 26.2+", () => {
    const pin = /DMGBUILD_VERSION="(\d+)\.(\d+)\.(\d+)"/.exec(createDmg);
    expect(pin).not.toBeNull();
    const [major, minor, patch] = pin!.slice(1).map(Number);
    const atLeast = (a: number[], b: number[]) => {
      for (let i = 0; i < b.length; i += 1) {
        if (a[i] !== b[i]) return a[i] > b[i];
      }
      return true;
    };
    expect(atLeast([major, minor, patch], [1, 6, 7])).toBe(true);
  });

  it("only ever runs the pinned dmgbuild", () => {
    // A dmgbuild picked up from PATH, or left in a reused venv, can be any
    // version — including one that ships an invisible background.
    expect(createDmg).not.toMatch(/command -v dmgbuild/);
    expect(createDmg).toMatch(/importlib\.metadata/);
    expect(createDmg).toMatch(/"\$installed" != "\$DMGBUILD_VERSION"/);
  });

  it("checks the built image's background before calling it done", () => {
    // The regression is silent — the build succeeds and the layout is right —
    // so the packaging step mounts the result and inspects its .DS_Store.
    expect(createDmg).toContain(
      'VERIFY_DS_STORE="$DMG_DIR/verify_ds_store.py"',
    );
    expect(createDmg).toMatch(/hdiutil attach "\$DMG_PATH" -readonly/);
    expect(createDmg).toMatch(
      /"\$DMGBUILD_PYTHON" "\$VERIFY_DS_STORE" "\$VERIFY_MOUNT"/,
    );
    const build = createDmg.indexOf('"$DMGBUILD" \\');
    const verify = createDmg.indexOf('"$DMGBUILD_PYTHON" "$VERIFY_DS_STORE"');
    const done = createDmg.indexOf("==> DMG created");
    expect(build).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(build);
    expect(done).toBeGreaterThan(verify);

    expect(verifyDsStore).toMatch(/b"pBBk"/);
    expect(verifyDsStore).toMatch(/backgroundImageAlias/);
    expect(verifyDsStore).toMatch(/sys\.exit\(1\)/);
  });

  it("fails loudly rather than shipping an unstyled disk image", () => {
    // No silent fallback to a bare `hdiutil create`: an unstyled DMG that
    // still uploads is worse than a failed build, because nobody notices.
    expect(createDmg).toMatch(/missing required file/);
    expect(createDmg).not.toMatch(/hdiutil\s+create/);
  });

  it("lays the window out exactly as the Figma frame specifies", () => {
    // Figma "Installer" node 3133:57 is 720x504 including a 34px mock title
    // bar; Finder draws the real title bar, so the content area is 720x470.
    expect(settings).toContain("window_rect = ((200, 120), (720, 470))");
    expect(settings).toContain("icon_size = 132");
    expect(settings).toContain("text_size = 13");
    expect(settings).toContain('default_view = "icon-view"');
    expect(settings).toContain('label_pos = "bottom"');
  });

  it("places both icons on the coordinates the artwork was drawn for", () => {
    expect(settings).toMatch(/app_name:\s*\(222,\s*273\)/);
    expect(settings).toMatch(/"Applications":\s*\(498,\s*273\)/);
    expect(settings).toContain('symlinks = {"Applications": "/Applications"}');
  });

  it("hides the Finder chrome so the artwork is the whole window", () => {
    for (const key of [
      "show_status_bar",
      "show_tab_view",
      "show_toolbar",
      "show_pathbar",
      "show_sidebar",
    ]) {
      expect(settings).toContain(`${key} = False`);
    }
  });

  it("gives the mounted volume the HQ icon", () => {
    expect(settings).toContain('icon = defines["volume_icon"]');
    expect(createDmg).toContain("icons/icon.icns");
  });

  it("ships the background at both 1x and 2x so Retina stays sharp", () => {
    const pages = tiffPageSizes(backgroundTiff);
    expect(pages).toEqual([
      [720, 470],
      [1440, 940],
    ]);
  });

  it("keeps the icons out of the background artwork", () => {
    // Finder draws HQ.app and Applications itself from their .icns files.
    // Drawing them into the background too would render them twice.
    expect(backgroundHtml).toContain("width:720px;height:470px");
    expect(backgroundHtml).not.toMatch(/applications-alias|hq-logo|<img/i);
    expect(backgroundHtml).not.toMatch(/class="drop"/);
  });

  it("still wires create-dmg.sh into the release workflow", () => {
    expect(releaseWorkflow).toContain("bash scripts/create-dmg.sh");
  });
});
