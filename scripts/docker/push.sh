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

docker_require_command aws
docker_require_command docker
docker_configure_aws_args

for target in "${DOCKER_TARGETS[@]}"; do
  docker_configure_target "${target}"

  describe_error=""
  if ! describe_error="$(aws ecr describe-repositories \
    --registry-id "${HUB_ACCOUNT_ID}" \
    --repository-names "${DOCKER_REPOSITORY_NAME}" \
    "${DOCKER_AWS_ARGS[@]}" 2>&1 >/dev/null)"; then
    if [[ "${describe_error}" == *"AccessDeniedException"* ]]; then
      echo "Warning: Unable to check whether ECR repository ${DOCKER_REPOSITORY_NAME} exists; attempting to push to the existing repository." >&2
    elif [[ "${describe_error}" != *"RepositoryNotFoundException"* ]]; then
      echo "${describe_error}" >&2
      exit 1
    else
      echo "Creating ECR repository ${DOCKER_REPOSITORY_NAME}..."
      aws ecr create-repository \
        --registry-id "${HUB_ACCOUNT_ID}" \
        --repository-name "${DOCKER_REPOSITORY_NAME}" \
        "${DOCKER_AWS_ARGS[@]}" >/dev/null
    fi
  fi

  if [[ "${target}" == "sandbox-agent-runtime" ]]; then
    # deploy.sh only deploys an image tagged with the current source's tag.
    source_tag="$(docker image inspect \
      --format "{{ index .Config.Labels \"${DOCKER_SOURCE_TAG_LABEL}\" }}" \
      "${DOCKER_IMAGE_URI}" 2>/dev/null || true)"
    [[ "${source_tag}" == source-* ]] ||
      docker_fail "${DOCKER_IMAGE_URI} has no source tag label. Rebuild it: npm run docker:build -- sandbox-agent-runtime"
    docker tag "${DOCKER_IMAGE_URI}" "${DOCKER_REPOSITORY_URI}:${source_tag}"
    docker push "${DOCKER_REPOSITORY_URI}:${source_tag}"
  fi

  docker push "${DOCKER_IMAGE_URI}"
done
