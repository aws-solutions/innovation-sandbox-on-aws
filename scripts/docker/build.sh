#!/usr/bin/env bash

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ "$#" -gt 1 ]]; then
  echo "Usage: $0 [account-cleaner|sandbox-agent-runtime|all]" >&2
  exit 1
fi

docker_load_environment
docker_validate_repository_configuration
docker_resolve_targets "${1:-all}"
cd "${DOCKER_REPOSITORY_ROOT}"

docker_require_command docker

for target in "${DOCKER_TARGETS[@]}"; do
  docker_configure_target "${target}"

  case "${target}" in
    account-cleaner)
      docker build \
        --platform linux/amd64 \
        -t "${DOCKER_IMAGE_URI}" \
        ./source/infrastructure/lib/components/account-cleaner/image
      ;;
    sandbox-agent-runtime)
      source_tag="$(docker_agent_runtime_source_tag)"
      DOCKER_BUILDKIT=1 docker build \
        --platform linux/arm64 \
        -f ./source/infrastructure/lib/components/sandbox-agent-runtime/image/Dockerfile \
        --label "${DOCKER_SOURCE_TAG_LABEL}=${source_tag}" \
        -t "${DOCKER_IMAGE_URI}" \
        -t "${DOCKER_REPOSITORY_URI}:${source_tag}" \
        .
      ;;
  esac
done
