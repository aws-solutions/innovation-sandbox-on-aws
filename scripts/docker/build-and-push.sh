#!/usr/bin/env bash

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ "$#" -gt 1 ]]; then
  echo "Usage: $0 [account-cleaner|sandbox-agent-runtime|all]" >&2
  exit 1
fi

target="${1:-all}"
docker_resolve_targets "${target}"

"${DOCKER_SCRIPT_DIR}/build.sh" "${target}"
"${DOCKER_SCRIPT_DIR}/login.sh"
"${DOCKER_SCRIPT_DIR}/push.sh" "${target}"
