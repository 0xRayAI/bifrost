#!/usr/bin/env bash
# Print the name: line under ## Owner. No output when the file or the line is missing.
set -euo pipefail
file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  exit 0
fi
awk '
  /^## / { owner = ($0 ~ /^## Owner[[:space:]]*$/) }
  owner && /^name:[[:space:]]*/ {
    sub(/^name:[[:space:]]*/, "")
    sub(/[[:space:]]+$/, "")
    if ($0 != "") print
    exit
  }
' "$file"
