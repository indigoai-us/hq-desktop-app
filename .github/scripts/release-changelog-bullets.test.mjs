import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BULLETS,
  buildAnnouncement,
  buildBullets,
  capBullets,
} from "./release-changelog-bullets.mjs";

test("turns a merge commit into '#N title' using the looked-up PR title", () => {
  const bullets = buildBullets(
    ["Merge pull request #684 from indigoai-us/lifecycle-cards"],
    (pr) => (pr === 684 ? "Channel-native company lifecycle" : null),
  );
  assert.deepEqual(bullets, ["#684 Channel-native company lifecycle"]);
});

test("turns a squash commit into '#N title' without any lookup", () => {
  const bullets = buildBullets(["Fix Windows updater signature check (#671)"]);
  assert.deepEqual(bullets, ["#671 Fix Windows updater signature check"]);
});

test("keeps titles exactly as written", () => {
  const bullets = buildBullets(["fix(sync): DON'T re-enroll on 403 — retry once (#42)"]);
  assert.deepEqual(bullets, ["#42 fix(sync): DON'T re-enroll on 403 — retry once"]);
});

test("falls back to the bare PR number when no title is available", () => {
  const bullets = buildBullets(["Merge pull request #7 from indigoai-us/wip"], () => null);
  assert.deepEqual(bullets, ["#7"]);
});

test("skips commits with no PR reference", () => {
  const bullets = buildBullets([
    "chore: stamp version 0.10.194",
    "Fix tray flicker (#12)",
    "",
    "   ",
  ]);
  assert.deepEqual(bullets, ["#12 Fix tray flicker"]);
});

test("de-duplicates a PR that appears twice", () => {
  const bullets = buildBullets([
    "Merge pull request #55 from indigoai-us/a",
    "Something (#55)",
  ], () => "Something");
  assert.deepEqual(bullets, ["#55 Something"]);
});

test("caps at 12 bullets and reports how many were omitted", () => {
  const subjects = Array.from({ length: 20 }, (_, i) => `Change ${i} (#${i + 100})`);
  const { bullets, omitted } = capBullets(buildBullets(subjects));
  assert.equal(MAX_BULLETS, 12);
  assert.equal(bullets.length, 12);
  assert.equal(omitted, 8);
  assert.equal(bullets[0], "#100 Change 0");
});

test("does not cap when there are 12 or fewer bullets", () => {
  const subjects = Array.from({ length: 12 }, (_, i) => `Change ${i} (#${i + 1})`);
  const { bullets, omitted } = capBullets(buildBullets(subjects));
  assert.equal(bullets.length, 12);
  assert.equal(omitted, 0);
});

test("builds the full announcement message", () => {
  const message = buildAnnouncement({
    version: "0.10.194",
    previousTag: "v0.10.193",
    bullets: ["#684 Channel-native company lifecycle", "#671 Fix Windows updater"],
    omitted: 0,
  });
  assert.equal(
    message,
    [
      "HQ desktop v0.10.194 is being built now — public in ~20 min once checks pass.",
      "Changes since v0.10.193:",
      "- #684 Channel-native company lifecycle",
      "- #671 Fix Windows updater",
    ].join("\n"),
  );
});

test("announcement mentions the overflow count", () => {
  const message = buildAnnouncement({
    version: "1.0.0",
    previousTag: "v0.9.0",
    bullets: ["#1 One"],
    omitted: 3,
  });
  assert.match(message, /- …and 3 more$/);
});

test("announcement stays readable when nothing merged", () => {
  const message = buildAnnouncement({
    version: "0.10.194",
    previousTag: "v0.10.193",
    bullets: [],
  });
  assert.equal(
    message,
    [
      "HQ desktop v0.10.194 is being built now — public in ~20 min once checks pass.",
      "No merged pull requests since v0.10.193.",
    ].join("\n"),
  );
});

test("announcement handles a first-ever release with no previous tag", () => {
  const message = buildAnnouncement({ version: "0.1.0", previousTag: "", bullets: [] });
  assert.match(message, /No previous release tag to compare against\./);
});
