#!/bin/sh
set -eu
DS_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$DS_ROOT/launcher/find-node.sh"
show_guide() {
  DS_MESSAGE=$1
  if [ "$(uname -s)" = Darwin ]; then
    /usr/bin/osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title "DS-Studio" buttons {"OK"} default button "OK"' -e 'end run' "$DS_MESSAGE" >/dev/null 2>&1 || true
    open "$DS_ROOT/launcher/INSTALLATION.html"
  else
    if command -v zenity >/dev/null 2>&1; then
      zenity --error --no-markup --title=DS-Studio --text="$DS_MESSAGE" 2>/dev/null || true
    fi
    xdg-open "$DS_ROOT/launcher/INSTALLATION.html" >/dev/null 2>&1 || true
  fi
}
if ! find_node; then show_guide 'Node.js 22.12 ou supérieur avec npm est absent ou trop ancien. Le guide va s’ouvrir. Installez Node.js LTS, puis relancez DS-Studio. Aucun réglage système modifié par le lanceur.'; exit 1; fi
PATH="$(dirname "$DS_NODE"):$PATH"
export PATH
if DS_RESULT=$("$DS_NODE" "$DS_ROOT/scripts/launcher.mjs" 2>&1); then exit 0; else show_guide "$DS_RESULT"; exit 1; fi
