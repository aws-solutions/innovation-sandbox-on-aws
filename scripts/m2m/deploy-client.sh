#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck source-path=SCRIPTDIR
#
# Deploy one M2M client stack from the IsbM2mClient template.
#
# Per-client M2M model: each automation client (CI/CD pipeline, batch
# job, external integration) gets its own CloudFormation stack named
# `${stackPrefix}-M2mClient-<Role>-<clientName>` (matching the naming
# style of the parent stacks like `${stackPrefix}-Compute`). The other
# M2M scripts (list-clients.sh, smoke-test.sh, revoke-m2m-role.sh)
# discover deployed clients via the aws-solutions:isb-stack-type=M2mClient
# tag (paired with aws-solutions:isb-id=<namespace>_isb for namespace
# scoping), so the stack-name shape is a convention rather than a hard
# requirement.
#
# To remove a client: `cdk destroy <stack-name>` or `aws cloudformation
# delete-stack --stack-name <stack-name>`.
#
# Usage:
#   ./deploy-client.sh \
#     --namespace myisb \
#     --client-name deploy-pipeline \
#     --role Admin \
#     --trusted-principal arn:aws:iam::123456789012:role/codebuild-pipeline
#
#   ./deploy-client.sh \
#     -n myisb -c qa-bot -r Manager \
#     -p 123456789012 \
#     --max-session-duration 14400

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# PROJECT_ROOT is only resolved when we're synthesizing in-tree (no
# --template given). Customers running this script with a pre-built
# template don't need a source checkout.
PROJECT_ROOT=""

# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

NAMESPACE=""
CLIENT_NAME=""
ROLE=""
TRUSTED_PRINCIPAL=""
MAX_SESSION_DURATION=""
REGION="${AWS_REGION:-${DEPLOY_REGION:-us-east-1}}"
PROFILE=""
STACK_PREFIX="${STACK_PREFIX:-InnovationSandbox}"
TEMPLATE=""
SKIP_CONFIRMATION=false
VERBOSE="false"

print_usage() {
  cat >&2 <<EOF
Usage: deploy-client.sh --namespace <ns> --client-name <name> --role <Admin|Manager|User> \\
                        --trusted-principal <arn-or-account-id> [options]

Deploys one M2M client stack from the IsbM2mClient template.
The CloudFormation stack name is forced to '<stackPrefix>-M2mClient-<Role>-<clientName>'
so the other M2M scripts can auto-discover it (matching the parent stacks'
'<stackPrefix>-Compute', '<stackPrefix>-Data' naming convention).

Required:
  --namespace, -n            ISB namespace (1-8 alphanumeric chars; must match the existing ISB deployment)
  --client-name, -c          Short identifier for this client (3-32 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen)
  --role, -r                 ISB role: Admin, Manager, or User
  --trusted-principal, -p    IAM ARN (e.g. arn:aws:iam::123:role/codebuild-pipeline) OR a 12-digit account ID

Options:
  --max-session-duration, -d   AssumeRole MaxSessionDuration in seconds (3600-43200; default: 3600 = 1 hour)
  --region                     AWS region (default: \$AWS_REGION, \$DEPLOY_REGION, or us-east-1)
  --profile                    AWS profile (defaults to the hub-account profile from .env if available)
  --template                   Path to a local CFN template file (pre-built IsbM2mClient template).
                               When given, the script skips CDK synth entirely — no source checkout
                               required. To deploy a template hosted in S3 or HTTPS, fetch it locally
                               first (e.g. \`aws s3 cp s3://bucket/key ./template.json\`) and pass the
                               local path here. \`aws cloudformation deploy\` does not accept S3/HTTPS
                               URLs directly.
                               When omitted, the script synthesizes from the in-tree CDK source.
  --stack-prefix               Stack-name prefix used to construct the deployed stack name
                               (\$STACK_PREFIX or 'InnovationSandbox'). Also passed as the
                               \`stackPrefix\` CDK context when synthesizing in-tree.
  --skip-confirmation          Don't prompt before deploying
  --verbose, -v                Print resolved values, AWS calls, and synth output to stderr
  --help, -h                   Show this help

Examples:
  # Pin to a specific principal
  ./deploy-client.sh -n myisb -c deploy-pipeline -r Admin \\
    -p arn:aws:iam::123456789012:role/codebuild-pipeline

  # Trust an entire account (gated by ExternalId)
  ./deploy-client.sh -n myisb -c qa-bot -r Manager -p 123456789012

  # 4-hour sessions
  ./deploy-client.sh -n myisb -c monthly-report -r User \\
    -p arn:aws:iam::123456789012:role/cron-runner \\
    -d 14400
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace|-n) NAMESPACE="$2"; shift 2 ;;
    --client-name|-c) CLIENT_NAME="$2"; shift 2 ;;
    --role|-r) ROLE="$2"; shift 2 ;;
    --trusted-principal|-p) TRUSTED_PRINCIPAL="$2"; shift 2 ;;
    --max-session-duration|-d) MAX_SESSION_DURATION="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --stack-prefix) STACK_PREFIX="$2"; shift 2 ;;
    --template) TEMPLATE="$2"; shift 2 ;;
    --skip-confirmation) SKIP_CONFIRMATION=true; shift ;;
    --verbose|-v) VERBOSE="true"; shift ;;
    --help|-h) print_usage; exit 0 ;;
    *) log_err "Unknown argument: $1"; print_usage; exit 2 ;;
  esac
done

# When --template is supplied the script can run outside a source checkout;
# otherwise PROJECT_ROOT is resolved for the in-tree CDK synth.
if [[ -n "$TEMPLATE" ]]; then
  # `-` is the conventional stdin sentinel; reject explicitly so we don't
  # try to deploy a file literally named `-`.
  if [[ "$TEMPLATE" == "-" ]]; then
    log_err "--template '-' (stdin) is not supported. Pass a path to a local file."
    exit 2
  fi
  # `aws cloudformation deploy` only accepts a local path — no --template-url.
  # Customers wanting to deploy from S3/HTTPS must fetch the template first
  # (`aws s3 cp s3://bucket/key ./template.json` or curl) and pass the local
  # path here.
  case "$TEMPLATE" in
    https://*|http://*|s3://*)
      log_err "--template does not accept URLs. Fetch it locally first (e.g. 'aws s3 cp $TEMPLATE ./template.json') and pass the file path."
      exit 2
      ;;
  esac
  if [[ ! -f "$TEMPLATE" ]]; then
    log_err "Template file not found: $TEMPLATE"
    exit 2
  fi
  # Normalise to absolute path so a later `cd` (none today, but defensive)
  # or aws-cli's relative-path handling can't surprise us.
  TEMPLATE="$(cd "$(dirname "$TEMPLATE")" && pwd)/$(basename "$TEMPLATE")"
else
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

# Default profile from .env if we're running in-tree and the user didn't
# pass --profile. Customers running with --template don't have a .env to
# read.
if [[ -z "$PROFILE" && -n "$PROJECT_ROOT" && -f "${PROJECT_ROOT}/.env" ]]; then
  PROFILE=$(grep -E '^HUB_ACCOUNT_PROFILE=' "${PROJECT_ROOT}/.env" | head -1 | cut -d'=' -f2- | tr -d '"' || true)
fi

# Validate required args
missing=()
[[ -z "$NAMESPACE" ]] && missing+=("--namespace")
[[ -z "$CLIENT_NAME" ]] && missing+=("--client-name")
[[ -z "$ROLE" ]] && missing+=("--role")
[[ -z "$TRUSTED_PRINCIPAL" ]] && missing+=("--trusted-principal")
if [[ ${#missing[@]} -gt 0 ]]; then
  log_err "Missing required arguments: ${missing[*]}"
  print_usage
  exit 2
fi

# Client-side validation (cheap fail-fast — the CFN template re-validates server-side)
if ! [[ "$NAMESPACE" =~ ^[a-zA-Z0-9]{1,8}$ ]]; then
  log_err "Namespace must be 1-8 alphanumeric characters (got: '$NAMESPACE')"
  exit 2
fi
if ! [[ "$CLIENT_NAME" =~ ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$ ]]; then
  log_err "Client name must be 3-32 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen (got: '$CLIENT_NAME')"
  exit 2
fi
case "$ROLE" in
  Admin|Manager|User) ;;
  *) log_err "Role must be one of: Admin, Manager, User (got: '$ROLE')"; exit 2 ;;
esac
if ! [[ "$TRUSTED_PRINCIPAL" =~ ^(arn:(aws|aws-cn|aws-us-gov):iam::[0-9]{12}:(role|user)/.+|[0-9]{12})$ ]]; then
  log_err "Trusted principal must be either an IAM ARN or a 12-digit account ID (got: '$TRUSTED_PRINCIPAL')"
  exit 2
fi
if [[ -n "$MAX_SESSION_DURATION" ]]; then
  if ! [[ "$MAX_SESSION_DURATION" =~ ^[0-9]+$ ]] || (( MAX_SESSION_DURATION < 3600 )) || (( MAX_SESSION_DURATION > 43200 )); then
    log_err "Max session duration must be a number between 3600 and 43200 seconds (got: '$MAX_SESSION_DURATION')"
    exit 2
  fi
fi

# IAM caps role names at 64 characters. The constructed name is
# `<namespace>-isb-m2m-<lowercased-role>-<clientName>` — worst case
# 8 + 9 + 7 + 1 + 32 = 57 chars, within the limit. The Namespace and
# ClientName allowedPattern constraints (above and in the CFN template)
# already enforce this bound; the explicit check below is defense-in-depth
# so a future widening of either pattern surfaces the issue here, with a
# clear error, rather than at IAM role creation with an opaque CFN failure.
ROLE_LC="$(printf '%s' "$ROLE" | tr '[:upper:]' '[:lower:]')"
ROLE_NAME_LEN=$((${#NAMESPACE} + ${#ROLE_LC} + ${#CLIENT_NAME} + 10))  # 10 = "-isb-m2m--"
if (( ROLE_NAME_LEN > 64 )); then
  log_err "Constructed IAM role name '${NAMESPACE}-isb-m2m-${ROLE_LC}-${CLIENT_NAME}' is ${ROLE_NAME_LEN} chars, which exceeds IAM's 64-character limit. Shorten --namespace or --client-name."
  exit 2
fi

STACK_NAME="${STACK_PREFIX}-M2mClient-${ROLE}-${CLIENT_NAME}"
SYNTH_STACK="${STACK_PREFIX}-M2mClient"

# When synthesizing in-tree, the synth output lands at this path.
TEMPLATE_PATH=""
[[ -z "$TEMPLATE" ]] && TEMPLATE_PATH="${PROJECT_ROOT}/source/infrastructure/cdk.out/${SYNTH_STACK}.template.json"

debug "Stack name:        ${STACK_NAME}"
debug "Region:            ${REGION}"
debug "Profile:           ${PROFILE:-<default chain>}"
if [[ -n "$TEMPLATE" ]]; then
  debug "Template:          ${TEMPLATE}"
else
  debug "Synth stack:       ${SYNTH_STACK}"
  debug "Synth output:      ${TEMPLATE_PATH}"
  debug "Project root:      ${PROJECT_ROOT}"
fi
if [[ "$VERBOSE" == "true" ]]; then
  AWS_BASE_ARGS_TMP=(--region "$REGION")
  [[ -n "$PROFILE" ]] && AWS_BASE_ARGS_TMP+=(--profile "$PROFILE")
  CALLER=$(aws sts get-caller-identity --output json "${AWS_BASE_ARGS_TMP[@]}" 2>&1 || true)
  debug "Caller identity: ${CALLER}"
fi

# Show the deploy summary, then delegate to confirm() from _common.sh.
# confirm() handles SKIP_CONFIRMATION + non-interactive detection +
# /dev/tty reads (vs raw stdin) — see _common.sh.
printf "========================================\n" >&2
printf "Deploy M2M Client Stack\n" >&2
printf "========================================\n" >&2
log_info "  Stack name:           ${STACK_NAME}"
log_info "  Namespace:            ${NAMESPACE}"
log_info "  Client name:          ${CLIENT_NAME}"
log_info "  Role:                 ${ROLE}"
log_info "  Trusted principal:    ${TRUSTED_PRINCIPAL}"
log_info "  Max session duration: ${MAX_SESSION_DURATION:-3600 (default)}"
log_info "  Region:               ${REGION}"
[[ -n "$PROFILE" ]] && log_info "  Profile:              ${PROFILE}"
if [[ -n "$TEMPLATE" ]]; then
  log_info "  Template:             ${TEMPLATE}"
else
  log_info "  Template:             synth in-tree from ${PROJECT_ROOT}"
fi
printf "\n" >&2
if ! confirm "Deploy stack ${STACK_NAME}?"; then
  log_info "Cancelled."
  exit 0
fi

AWS_BASE_ARGS=(--region "$REGION")
[[ -n "$PROFILE" ]] && AWS_BASE_ARGS+=(--profile "$PROFILE")

# Resolve the template source: in-tree CDK synth or supplied --template.
if [[ -z "$TEMPLATE" ]]; then
  log_info "Synthesizing CDK template (${SYNTH_STACK})..."
  cd "$PROJECT_ROOT" || exit 1
  SYNTH_CMD=(npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- synth "$SYNTH_STACK" --context "stackPrefix=${STACK_PREFIX}")
  # Skip --quiet under --verbose so the user sees CDK output
  [[ "$VERBOSE" != "true" ]] && SYNTH_CMD+=(--quiet)
  debug "Synth: ${SYNTH_CMD[*]}"
  "${SYNTH_CMD[@]}" >&2

  if [[ ! -f "$TEMPLATE_PATH" ]]; then
    log_err "Synthesized template not found at: $TEMPLATE_PATH"
    exit 1
  fi
  log_ok "Synthesis complete"
fi

# Build CFN parameter overrides. RestApiIdSsmParam is the NAME of the Compute
# stack's SSM parameter; the template reads it as AWS::SSM::Parameter::Value<String>,
# so CloudFormation re-resolves the current API ID on every deploy.
PARAM_OVERRIDES=(
  "Namespace=${NAMESPACE}"
  "ClientName=${CLIENT_NAME}"
  "Role=${ROLE}"
  "TrustedPrincipal=${TRUSTED_PRINCIPAL}"
  "RestApiIdSsmParam=InnovationSandbox_${NAMESPACE}_Compute_RestApiId"
)
[[ -n "$MAX_SESSION_DURATION" ]] && PARAM_OVERRIDES+=("MaxSessionDuration=${MAX_SESSION_DURATION}")

debug "Parameter overrides:"
for p in "${PARAM_OVERRIDES[@]}"; do debug "  ${p}"; done

# Either --template (set above) or the freshly-synthesized output.
DEPLOY_TEMPLATE_FILE="${TEMPLATE:-$TEMPLATE_PATH}"

log_info "Deploying CloudFormation stack: ${STACK_NAME}"
aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file "$DEPLOY_TEMPLATE_FILE" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "${PARAM_OVERRIDES[@]}" \
  --no-fail-on-empty-changeset \
  ${AWS_BASE_ARGS[@]+"${AWS_BASE_ARGS[@]}"}

log_ok "Stack ${STACK_NAME} deployed."

# Print outputs
log_info ""
log_info "Stack outputs:"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  ${AWS_BASE_ARGS[@]+"${AWS_BASE_ARGS[@]}"} \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table >&2

cat >&2 <<EOF

Next steps:
  # Assume the role:
  ./scripts/m2m/assume-m2m-role.sh --client-stack ${STACK_NAME} --output profile

  # Test:
  ./scripts/m2m/smoke-test.sh --client-stack ${STACK_NAME}

  # Tear down (permanent removal):
  aws cloudformation delete-stack --stack-name ${STACK_NAME}${PROFILE:+ --profile ${PROFILE}} --region ${REGION}
EOF
