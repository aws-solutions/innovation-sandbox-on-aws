#!/bin/bash
set -e
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# =============================================================================
# Deploy-specific functions
# =============================================================================

show_help() {
  cat <<EOF
Innovation Sandbox - Unified Deploy Script

Usage:
  ./scripts/cdk/deploy.sh                  Deploy all stacks (with confirmation)
  ./scripts/cdk/deploy.sh account-pool     Deploy only AccountPool stack
  ./scripts/cdk/deploy.sh idc              Deploy only IDC stack
  ./scripts/cdk/deploy.sh data             Deploy only Data stack
  ./scripts/cdk/deploy.sh compute          Deploy only Compute stack
  ./scripts/cdk/deploy.sh data compute     Deploy multiple specific stacks
  ./scripts/cdk/deploy.sh all              Deploy all stacks (explicit)

Options:
  --skip-confirmation    Skip the interactive confirmation prompt
  --skip-build           Skip the TypeScript build before synthesis
  --help, -h             Show this help message
EOF
  exit 0
}

validate_required_vars() {
  local stack="$1"
  local missing=()

  # Common required vars (all stacks)
  [ -z "$DEPLOY_REGION" ] && missing+=("DEPLOY_REGION")
  [ -z "$NAMESPACE" ] && missing+=("NAMESPACE")

  case "$stack" in
    account-pool)
      [ -z "$PARENT_OU_ID" ] && missing+=("PARENT_OU_ID")
      [ -z "$HUB_ACCOUNT_ID" ] && missing+=("HUB_ACCOUNT_ID")
      [ -z "$AWS_REGIONS" ] && missing+=("AWS_REGIONS")
      ;;
    idc)
      [ -z "$IDENTITY_STORE_ID" ] && missing+=("IDENTITY_STORE_ID")
      [ -z "$SSO_INSTANCE_ARN" ] && missing+=("SSO_INSTANCE_ARN")
      [ -z "$ORG_MGT_ACCOUNT_ID" ] && missing+=("ORG_MGT_ACCOUNT_ID")
      [ -z "$HUB_ACCOUNT_ID" ] && missing+=("HUB_ACCOUNT_ID")
      ;;
    data)
      [ -z "$SAML_METADATA_URL" ] && missing+=("SAML_METADATA_URL")
      [ -z "$AWS_ACCESS_PORTAL_URL" ] && missing+=("AWS_ACCESS_PORTAL_URL")
      ;;
    compute)
      [ -z "$ORG_MGT_ACCOUNT_ID" ] && missing+=("ORG_MGT_ACCOUNT_ID")
      [ -z "$IDC_ACCOUNT_ID" ] && missing+=("IDC_ACCOUNT_ID")
      [ -z "$ACCEPT_SOLUTION_TERMS_OF_USE" ] && missing+=("ACCEPT_SOLUTION_TERMS_OF_USE")
      ;;
  esac

  if [ ${#missing[@]} -gt 0 ]; then
    log_err "Missing required variables for '$stack' stack:"
    for var in "${missing[@]}"; do
      log_err "  - $var"
    done
    printf "Please set these in your .env file.\n"
    return 1
  fi
}

build_common_args() {
  CDK_CONTEXT_ARGS=()
  CDK_DEPLOY_ARGS=()

  [ -n "$STACK_PREFIX" ] && CDK_CONTEXT_ARGS+=(--context "stackPrefix=$STACK_PREFIX")
  [ -n "$DEPLOYMENT_MODE" ] && CDK_CONTEXT_ARGS+=(--context "deploymentMode=$DEPLOYMENT_MODE")

  # Logging and retention
  [ -n "$LOG_LEVEL" ] && CDK_CONTEXT_ARGS+=(--context "logLevel=$LOG_LEVEL")
  [ -n "$CLOUDWATCH_LOG_RETENTION_IN_DAYS" ] && CDK_CONTEXT_ARGS+=(--context "cloudWatchLogRetentionInDays=$CLOUDWATCH_LOG_RETENTION_IN_DAYS")
  [ -n "$S3_LOGS_ARCHIVE_RETENTION_IN_DAYS" ] && CDK_CONTEXT_ARGS+=(--context "s3LogsArchiveRetentionInDays=$S3_LOGS_ARCHIVE_RETENTION_IN_DAYS")
  [ -n "$S3_LOGS_GLACIER_RETENTION_IN_DAYS" ] && CDK_CONTEXT_ARGS+=(--context "s3LogsGlacierRetentionInDays=$S3_LOGS_GLACIER_RETENTION_IN_DAYS")

  # API throttling
  [ -n "$API_THROTTLING_RATE_LIMIT" ] && CDK_CONTEXT_ARGS+=(--context "apiThrottlingRateLimit=$API_THROTTLING_RATE_LIMIT")
  [ -n "$API_THROTTLING_BURST_LIMIT" ] && CDK_CONTEXT_ARGS+=(--context "apiThrottlingBurstLimit=$API_THROTTLING_BURST_LIMIT")

  # Cognito token validity
  [ -n "$COGNITO_ACCESS_TOKEN_VALIDITY_MINUTES" ] && CDK_CONTEXT_ARGS+=(--context "cognitoAccessTokenValidityMinutes=$COGNITO_ACCESS_TOKEN_VALIDITY_MINUTES")
  [ -n "$COGNITO_ID_TOKEN_VALIDITY_MINUTES" ] && CDK_CONTEXT_ARGS+=(--context "cognitoIdTokenValidityMinutes=$COGNITO_ID_TOKEN_VALIDITY_MINUTES")
  [ -n "$COGNITO_REFRESH_TOKEN_VALIDITY_DAYS" ] && CDK_CONTEXT_ARGS+=(--context "cognitoRefreshTokenValidityDays=$COGNITO_REFRESH_TOKEN_VALIDITY_DAYS")

  # Build-time context (affects synthesized templates)
  [ -n "$NUKE_CONFIG_FILE_PATH" ] && CDK_CONTEXT_ARGS+=(--context "nukeConfigFilePath=$NUKE_CONFIG_FILE_PATH")
  [ -n "$SCP_DIRECTORY_PATH" ] && CDK_CONTEXT_ARGS+=(--context "scpDirectoryPath=$SCP_DIRECTORY_PATH")
  [ -n "$PRIVATE_ECR_REPO" ] && CDK_CONTEXT_ARGS+=(--context "privateEcrRepo=$PRIVATE_ECR_REPO")

  # Tags (deploy-time only)
  if [ -n "$STACK_TAGS" ]; then
    read -ra TAG_ARRAY <<< "$STACK_TAGS"
    for tag in "${TAG_ARRAY[@]}"; do
      CDK_DEPLOY_ARGS+=(--tags "$tag")
    done
  fi
}

deploy_stack() {
  local stack="$1"
  local stack_name
  local profile
  stack_name=$(get_stack_name "$stack")
  profile=$(get_stack_profile "$stack")
  local args=(--app "${PROJECT_ROOT}/source/infrastructure/cdk.out" "$stack_name")

  # Namespace is required by all stacks
  args+=(--parameters "Namespace=$NAMESPACE")

  case "$stack" in
    account-pool)
      args+=(--parameters "ParentOuId=$PARENT_OU_ID")
      args+=(--parameters "HubAccountId=$HUB_ACCOUNT_ID")
      args+=(--parameters "IsbManagedRegions=$AWS_REGIONS")
      [ -n "$ADDITIONAL_ALLOWED_SERVICES" ] && args+=(--parameters "AdditionalAllowedServices=$ADDITIONAL_ALLOWED_SERVICES")
      [ -n "$ADDITIONAL_PRINCIPAL_EXCEPTIONS" ] && args+=(--parameters "AdditionalPrincipalExceptions=$ADDITIONAL_PRINCIPAL_EXCEPTIONS")
      [ -n "$BEDROCK_INFERENCE_PROFILE_PATTERNS" ] && args+=(--parameters "BedrockInferenceProfilePatterns=$BEDROCK_INFERENCE_PROFILE_PATTERNS")
      ;;
    idc)
      args+=(--parameters "IdentityStoreId=$IDENTITY_STORE_ID")
      args+=(--parameters "SsoInstanceArn=$SSO_INSTANCE_ARN")
      args+=(--parameters "OrgMgtAccountId=$ORG_MGT_ACCOUNT_ID")
      args+=(--parameters "HubAccountId=$HUB_ACCOUNT_ID")
      [ -n "$ADMIN_GROUP_NAME" ] && args+=(--parameters "AdminGroupName=$ADMIN_GROUP_NAME")
      [ -n "$MANAGER_GROUP_NAME" ] && args+=(--parameters "ManagerGroupName=$MANAGER_GROUP_NAME")
      [ -n "$USER_GROUP_NAME" ] && args+=(--parameters "UserGroupName=$USER_GROUP_NAME")
      ;;
    data)
      args+=(--parameters "SamlMetadataUrl=$SAML_METADATA_URL")
      args+=(--parameters "AwsAccessPortalUrl=$AWS_ACCESS_PORTAL_URL")
      ;;
    compute)
      args+=(--parameters "OrgMgtAccountId=$ORG_MGT_ACCOUNT_ID")
      args+=(--parameters "IdcAccountId=$IDC_ACCOUNT_ID")
      args+=(--parameters "AcceptSolutionTermsOfUse=$ACCEPT_SOLUTION_TERMS_OF_USE")
      [ -n "$CUSTOM_DOMAIN_NAME" ] && args+=(--parameters "CustomDomainName=$CUSTOM_DOMAIN_NAME")
      [ -n "$CUSTOM_DOMAIN_CERTIFICATE_ARN" ] && args+=(--parameters "CustomDomainCertificateArn=$CUSTOM_DOMAIN_CERTIFICATE_ARN")
      [ -n "$ALLOW_LISTED_IP_RANGES" ] && args+=(--parameters "AllowListedIPRanges=$ALLOW_LISTED_IP_RANGES")
      [ -n "$USE_STABLE_TAGGING" ] && args+=(--parameters "UseStableTagging=$USE_STABLE_TAGGING")
      ;;
  esac

  [ -n "$profile" ] && args+=(--profile "$profile")
  args+=("${CDK_DEPLOY_ARGS[@]}")
  args+=(--require-approval=never)

  run_cdk deploy "${args[@]}"
}

show_confirmation() {
  if [ ! -t 0 ]; then
    log_err "Interactive confirmation required but stdin is not a terminal."
    printf "Use --skip-confirmation for non-interactive execution.\n"
    exit 1
  fi

  printf "========================================\n"
  printf "Innovation Sandbox - Deploy\n"
  printf "========================================\n"
  printf "\n"

  printf "Deployment Configuration:\n"
  log_info "  Deploy Region:            ${DEPLOY_REGION:-default}"
  log_info "  Stack Prefix:             ${PREFIX}"
  log_info "  Hub Account:              ${HUB_ACCOUNT_ID:-Not set}"
  log_info "  Org Mgt Account:          ${ORG_MGT_ACCOUNT_ID:-Not set}"
  log_info "  IDC Account:              ${IDC_ACCOUNT_ID:-Not set}"
  log_info "  Deployment Mode:          ${DEPLOYMENT_MODE:-prod (default)}"
  log_info "  Sandbox Account Regions:  ${AWS_REGIONS:-Not set}"
  printf "\n"

  printf "Stacks to deploy:\n"
  for stack in "${STACKS_TO_DEPLOY[@]}"; do
    local stack_name profile profile_flag account_info account_id
    stack_name=$(get_stack_name "$stack")
    profile=$(get_stack_profile "$stack")

    # Resolve credentials for this stack's profile
    profile_flag=""
    [ -n "$profile" ] && profile_flag="--profile $profile"

    set +e
    account_info=$(aws sts get-caller-identity --output json $profile_flag 2>&1)
    local exit_code=$?
    set -e

    if [ $exit_code -ne 0 ]; then
      log_err "Failed to resolve AWS credentials for '$stack' stack${profile:+ (profile: $profile)}"
      exit 1
    fi

    account_id=$(printf '%s' "$account_info" | grep -o '"Account": "[^"]*' | cut -d'"' -f4)

    printf "  - %s\n" "$stack_name"
    log_info "      account: $account_id"
    [ -n "$profile" ] && log_info "      profile: $profile"
    [ -n "$STACK_TAGS" ] && log_info "      tags:    $STACK_TAGS"
  done
  printf "\n"

  log_warn "Do you want to continue? (y/N) "
  read -r response

  if [[ ! "$response" =~ ^[Yy]$ ]]; then
    printf "\nDeployment cancelled.\n"
    exit 0
  fi
}

# =============================================================================
# Execution
# =============================================================================

# Parse arguments
STACKS_TO_DEPLOY=()
SKIP_CONFIRMATION=false
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --help|-h) show_help ;;
    --skip-confirmation) SKIP_CONFIRMATION=true ;;
    --skip-build) SKIP_BUILD=true ;;
    account-pool|idc|data|compute) STACKS_TO_DEPLOY+=("$arg") ;;
    all) STACKS_TO_DEPLOY=(account-pool idc data compute) ;;
    *)
      log_err "Unknown argument: $arg"
      printf "Usage: %s [account-pool|idc|data|compute|all] [--skip-confirmation] [--skip-build] [--help]\n" "$0"
      exit 1
      ;;
  esac
done

if [ ${#STACKS_TO_DEPLOY[@]} -eq 0 ]; then
  STACKS_TO_DEPLOY=(account-pool idc data compute)
fi

check_dependencies
load_env
resolve_stack_names
build_common_args

# Validate required vars before confirmation and synth
for stack in "${STACKS_TO_DEPLOY[@]}"; do
  if ! validate_required_vars "$stack"; then
    exit 1
  fi
done

# Confirmation
if [ "$SKIP_CONFIRMATION" = false ]; then
  show_confirmation
fi

# Build
# The generated packages under source/api-client and source/api-server are
# gitignored, so on a fresh checkout synth cannot resolve them at all — and on a
# warm tree it silently resolves a stale copy after the model changes. Matches
# what deployment/build-s3-dist.sh does before its own synth.
if [ "$SKIP_BUILD" = false ]; then
  printf "\n"
  log_info "Building TypeScript packages..."

  set +e
  npm run build
  BUILD_EXIT=$?
  set -e

  if [ $BUILD_EXIT -ne 0 ]; then
    log_err "Build failed"
    exit 1
  fi

  log_ok "Build complete"
else
  printf "\n"
  log_warn "Skipping build (--skip-build); generated code may be stale"
fi

# Synth
printf "\n"
log_info "Synthesizing CDK application..."

set +e
run_cdk synth "${CDK_CONTEXT_ARGS[@]}"
SYNTH_EXIT=$?
set -e

if [ $SYNTH_EXIT -ne 0 ]; then
  log_err "CDK synthesis failed"
  exit 1
fi

log_ok "Synthesis complete"
printf "\n"

# Deploy
SUCCEEDED_STACKS=()
FAILED_STACK=""

for stack in "${STACKS_TO_DEPLOY[@]}"; do
  DISPLAY_NAME=$(get_stack_name "$stack")

  log_info "Deploying ${DISPLAY_NAME}..."
  DEPLOY_START=$(date +%s)

  set +e
  deploy_stack "$stack"
  DEPLOY_EXIT=$?
  set -e

  DEPLOY_DURATION=$(( $(date +%s) - DEPLOY_START ))

  if [ $DEPLOY_EXIT -ne 0 ]; then
    FAILED_STACK="$stack"
    log_err "${DISPLAY_NAME} FAILED (${DEPLOY_DURATION}s)"
    break
  fi

  SUCCEEDED_STACKS+=("$stack")
  log_ok "${DISPLAY_NAME} complete (${DEPLOY_DURATION}s)"
  printf "\n"
done

print_summary "Deployment" "${STACKS_TO_DEPLOY[@]}"
if [ -n "$FAILED_STACK" ]; then exit 1; fi
