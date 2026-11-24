#!/usr/bin/env bash
# Shared helpers for scripts/docker entrypoints. This file must be sourced.
# shellcheck disable=SC2034 # Globals are consumed by the scripts that source this file.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "This file must be sourced by a Docker command." >&2
  exit 1
fi

set -euo pipefail

DOCKER_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_REPOSITORY_ROOT="$(cd -- "${DOCKER_SCRIPT_DIR}/../.." && pwd)"
DOCKER_ENV_FILE="${DOCKER_REPOSITORY_ROOT}/.env"

docker_fail() {
  echo "Error: $*" >&2
  exit 1
}

docker_require_command() {
  command -v "$1" >/dev/null 2>&1 || docker_fail "Required command '$1' not found in PATH."
}

docker_require_variable() {
  local variable_name="$1"
  [[ -n "${!variable_name:-}" ]] || docker_fail "${variable_name} is not set in ${DOCKER_ENV_FILE}."
}

docker_load_environment() {
  [[ -f "${DOCKER_ENV_FILE}" ]] ||
    docker_fail ".env file not found. Run 'npm run env:init' to create it."

  # shellcheck disable=SC1090
  source "${DOCKER_ENV_FILE}"

  docker_require_variable HUB_ACCOUNT_ID
  docker_require_variable DEPLOY_REGION
}

docker_configure_aws_args() {
  DOCKER_AWS_ARGS=(--region "${DEPLOY_REGION}")
  if [[ -n "${HUB_ACCOUNT_PROFILE:-}" ]]; then
    DOCKER_AWS_ARGS+=(--profile "${HUB_ACCOUNT_PROFILE}")
  fi
}

docker_validate_repository_configuration() {
  if [[ -n "${PRIVATE_ACCOUNT_CLEANER_ECR_REPO:-}" &&
        -n "${PRIVATE_SANDBOX_AGENT_RUNTIME_ECR_REPO:-}" &&
        "${PRIVATE_ACCOUNT_CLEANER_ECR_REPO}" == "${PRIVATE_SANDBOX_AGENT_RUNTIME_ECR_REPO}" ]]; then
    docker_fail "PRIVATE_ACCOUNT_CLEANER_ECR_REPO and PRIVATE_SANDBOX_AGENT_RUNTIME_ECR_REPO must use different repositories."
  fi
}

docker_resolve_targets() {
  case "${1:-all}" in
    all)
      DOCKER_TARGETS=(account-cleaner sandbox-agent-runtime)
      ;;
    account-cleaner|sandbox-agent-runtime)
      DOCKER_TARGETS=("$1")
      ;;
    *)
      docker_fail "Unknown Docker target '$1'. Expected 'account-cleaner', 'sandbox-agent-runtime', or 'all'."
      ;;
  esac
}

docker_configure_target() {
  local target="$1"

  case "${target}" in
    account-cleaner)
      docker_require_variable PRIVATE_ACCOUNT_CLEANER_ECR_REPO
      DOCKER_REPOSITORY_NAME="${PRIVATE_ACCOUNT_CLEANER_ECR_REPO}"
      ;;
    sandbox-agent-runtime)
      docker_require_variable PRIVATE_SANDBOX_AGENT_RUNTIME_ECR_REPO
      DOCKER_REPOSITORY_NAME="${PRIVATE_SANDBOX_AGENT_RUNTIME_ECR_REPO}"
      ;;
    *)
      docker_fail "Unknown Docker target '${target}'. Expected 'account-cleaner' or 'sandbox-agent-runtime'."
      ;;
  esac

  DOCKER_REPOSITORY_URI="${HUB_ACCOUNT_ID}.dkr.ecr.${DEPLOY_REGION}.amazonaws.com/${DOCKER_REPOSITORY_NAME}"
  DOCKER_IMAGE_URI="${DOCKER_REPOSITORY_URI}:latest"
}

# Label recording which source an agent runtime image was built from, so push.sh
# tags the image it pushes rather than whatever the source is at push time.
DOCKER_SOURCE_TAG_LABEL="com.amazon.innovation-sandbox.source-tag"

# Prints the agent runtime's source tag (see agent-runtime-image.ts).
docker_agent_runtime_source_tag() {
  (cd "${DOCKER_REPOSITORY_ROOT}" && npm run --silent agent-runtime:source-tag) ||
    docker_fail "Could not compute the agent runtime source tag. Run 'npm install' first."
}
