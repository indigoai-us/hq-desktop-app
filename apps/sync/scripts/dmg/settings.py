# -*- coding: utf-8 -*-
"""dmgbuild settings for the HQ install window.

Layout is transcribed from Figma "Installer" (file zKBwNxXUMbypJEXSV01uyq,
node 3133:57). That frame is 720x504 and includes a mock 34px title bar; the
real window gets its title bar from Finder, so every y below is the frame value
minus 34 and the content area is 720x470.

Why dmgbuild rather than AppleScript: the traditional recipe styles a disk
image by telling Finder to open the volume and move the icons, which needs a
logged-in GUI session. Release builds run on a headless GitHub runner where
that is unavailable, so it would work on a laptop and fail in CI. dmgbuild
writes the .DS_Store directly and never talks to Finder.

Values come in as -D defines from create-dmg.sh.
"""

import os.path

application = defines["app"]  # noqa: F821 - injected by dmgbuild -D
app_name = os.path.basename(application)

# ---------------------------------------------------------------- volume ----
format = "UDZO"
compression_level = 9
filesystem = "HFS+"
size = None

files = [application]
symlinks = {"Applications": "/Applications"}

# The mounted volume shows the HQ mark instead of the generic drive icon.
icon = defines["volume_icon"]  # noqa: F821

# ------------------------------------------------------------------ view ----
background = defines["background"]  # noqa: F821

default_view = "icon-view"
show_icon_preview = False

# ((x, y), (width, height)) — width/height are the CONTENT area, matching the
# background artwork exactly.
window_rect = ((200, 120), (720, 470))

show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

arrange_by = None
grid_offset = (0, 0)
grid_spacing = 100
label_pos = "bottom"
text_size = 13

# 132 to match the Figma cell. The app's own .icns is laid out on Apple's icon
# grid (artwork at 824/1024 of the canvas), so it draws at about 106px inside
# that cell — which is what makes it sit level with the Applications folder,
# whose stock icon carries the same kind of internal margin.
icon_size = 132

# Icon centres in content coordinates. Figma puts the cells at y 241 with a
# height of 132, so the centre is 241 + 66 - 34 = 273.
icon_locations = {
    app_name: (222, 273),
    "Applications": (498, 273),
}

hide_extension = [app_name]
