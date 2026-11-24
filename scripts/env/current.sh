#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

if [[ "$#" -ne 0 ]]; then
  echo "Usage: npm run env:current" >&2
  exit 1
fi

show_current_environment
