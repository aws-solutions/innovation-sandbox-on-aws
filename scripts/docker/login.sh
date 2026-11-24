#!/usr/bin/env bash

set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ "$#" -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 1
fi

docker_load_environment
cd "${DOCKER_REPOSITORY_ROOT}"

docker_require_command aws
docker_require_command docker
docker_configure_aws_args

aws ecr get-login-password "${DOCKER_AWS_ARGS[@]}" |
  docker login \
    --username AWS \
    --password-stdin \
    "${HUB_ACCOUNT_ID}.dkr.ecr.${DEPLOY_REGION}.amazonaws.com"
