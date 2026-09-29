# The Kanna.dmg window, for dmgbuild (run by build.sh through uvx, so nothing
# is installed globally). dmgbuild writes the Finder layout itself instead of
# scripting Finder, so builds need no Automation permission and come out the
# same every time.
#
# A DMG with an Applications shortcut, rather than a zip, because an app run
# from where it was unzipped (Downloads) is App-Translocated: macOS runs a
# read-only copy from a random path, and the app can't update itself there.
# The window says "drag me to Applications" without a word.
#
#   uvx dmgbuild -s dmg-settings.py -D app=path/to/Kanna.app "Kanna" Kanna.dmg

import os.path

app = defines["app"]  # noqa: F821 (dmgbuild provides `defines`)
app_name = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
# No hide_extensions: it sets a Finder flag on Kanna.app itself, which the
# signature doesn't cover, so `codesign --verify --strict` (and a strict
# update check) calls the app damaged. Finder hides ".app" anyway.

# Kanna on the left, Applications on the right, dmgbuild's arrow between.
background = "builtin-arrow"
window_rect = ((200, 200), (640, 400))
icon_size = 128
text_size = 13
icon_locations = {
    app_name: (160, 200),
    "Applications": (480, 200),
}
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
