#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./launcher/find-node.sh
if ! find_node; then
  echo "Node.js absent du PATH. Installez Node.js LTS puis suivez README.md." >&2
  exit 1
fi
PATH="$(dirname "$DS_NODE"):$PATH"
export PATH
exec "$DS_NODE" scripts/launch.mjs
