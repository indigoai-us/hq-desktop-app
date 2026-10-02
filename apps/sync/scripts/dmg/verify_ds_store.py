# -*- coding: utf-8 -*-
"""Verify the install-window .DS_Store of a built, mounted HQ disk image.

Usage:
    python verify_ds_store.py <mounted-volume-path>

Run with the dmgbuild virtualenv's interpreter: it already has the ds_store and
mac_alias packages that dmgbuild itself depends on.

Why this exists: from macOS 26.2, Finder shows a blank window instead of the
background picture when the volume's .DS_Store carries a `pBBk` (background
bookmark) record. dmgbuild wrote that record up to 1.6.6, so every HQ.dmg built
with 1.6.5 opened with the icons laid out correctly on plain white — the
artwork was in the image, but no one on current macOS could see it
(dmgbuild/dmgbuild#273, Apple FB21405103). dmgbuild 1.6.7 stops writing it and
relies on the `icvp` background alias, which every macOS version reads.

The failure is silent: the build succeeds, the layout is right, and only a
human looking at the window on a new OS notices. So the packaging step checks
the built image directly and refuses to ship one that would regress.
"""

import os
import sys

from ds_store import DSStore
from mac_alias import Alias


def fail(message):
    print("Error: DMG background check failed: %s" % message, file=sys.stderr)
    sys.exit(1)


def main(argv):
    if len(argv) != 2:
        print("Usage: verify_ds_store.py <mounted-volume-path>", file=sys.stderr)
        return 2

    volume = argv[1]
    ds_store_path = os.path.join(volume, ".DS_Store")
    if not os.path.isfile(ds_store_path):
        fail("no .DS_Store on the volume at %s" % volume)

    with DSStore.open(ds_store_path, "r") as store:
        records = [(entry.filename, entry.code) for entry in store]
        bookmarks = [name for name, code in records if code == b"pBBk"]
        if bookmarks:
            fail(
                "the .DS_Store has a pBBk background bookmark, which makes "
                "Finder on macOS 26.2+ show a blank window. Build with "
                "dmgbuild >= 1.6.7."
            )

        try:
            icvp = store["."]["icvp"]
        except KeyError:
            fail("the volume root has no icon-view options (icvp)")

    if icvp.get("backgroundType") != 2:
        fail(
            "icon-view background type is %r, expected 2 (picture)"
            % icvp.get("backgroundType")
        )

    alias_bytes = icvp.get("backgroundImageAlias")
    if not alias_bytes:
        fail("icon-view options carry no backgroundImageAlias")

    alias = Alias.from_bytes(alias_bytes)
    target = alias.target.posix_path or ("/" + alias.target.filename)
    if not os.path.isfile(os.path.join(volume, target.lstrip("/"))):
        fail("background alias points at %s, which is not on the volume" % target)

    print("==> DMG background verified: %s via icvp alias, no pBBk" % target)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
