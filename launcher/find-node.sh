#!/bin/sh
# Ne source aucun profil utilisateur et ne change aucun réglage système.
find_node() {
  node_candidate=$(command -v node 2>/dev/null || true)
  for candidate in "$node_candidate" \
    /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node \
    "$HOME"/.local/opt/node-*/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node "$HOME"/.asdf/installs/nodejs/*/bin/node \
    "$HOME"/.local/share/mise/installs/node/*/bin/node; do
    if [ -x "$candidate" ] && "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=12?0:1)' >/dev/null 2>&1; then
      DS_NODE=$candidate
      export DS_NODE
      return 0
    fi
  done
  return 1
}
