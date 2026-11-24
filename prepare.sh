#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

mkdir -p "$SCRIPT_DIR/data"
echo "✔ data directory created"

chown 2000:2000 "$SCRIPT_DIR/data"
echo "✔ data directory restricted to user 2000, group 2000 (used by docker container)"
