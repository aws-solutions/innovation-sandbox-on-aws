#!/bin/bash
#
# This script packages your project into a solution distributable that can be
# used as an input to the solution builder validation pipeline.
#
# This script will perform the following tasks:
#   1. Remove any old dist files from previous runs.
#   2. Build and synthesize your CDK project.
#   3. Move templates into the /global-s3-assets folder.
#   4. Organize source code artifacts into the /regional-s3-assets folder.

set -e && [[ "$DEBUG" == 'true' ]] && set -x

# Source common functions
script_dir="$(dirname "$(realpath "$0")")"
source "$script_dir/build-common.sh"

# get command line arguments
POSITIONAL_ARGS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --solution-name)
      SOLUTION_NAME="$2"
      shift # past argument
      shift # past value
      ;;
    --solution-id)
      SOLUTION_ID="$2"
      shift # past argument
      shift # past value
      ;;
    --version)
      VERSION="$2"
      shift # past argument
      shift # past value
      ;;
    --dist-output-bucket)
      DIST_OUTPUT_BUCKET="$2"
      shift # past argument
      shift # past value
      ;;
    --public-ecr-registry)
      PUBLIC_ECR_REGISTRY="$2"
      shift # past argument
      shift # past value
      ;;
    --public-ecr-tag)
      PUBLIC_ECR_TAG="$2"
      shift # past argument
      shift # past value
      ;;
    --private-ecr-repo)
      PRIVATE_ECR_REPO="$2"
      shift # past argument
      shift # past value
      ;;
    --nuke-config-file-name)
      NUKE_CONFIG_FILE_PATH="$2"
      shift # past argument
      shift # past value
      ;;
    --log-level)
      LOG_LEVEL="$2"
      shift # past argument
      shift # past value
      ;;
    --deployment-mode)
      DEPLOYMENT_MODE="$2"
      shift # past argument
      shift # past value
      ;;
    --skip-build)
      SKIP_BUILD="true"
      shift # past argument
      ;;
    -*)
      printf "%bUnknown option $1\n%b" "${RED}" "${NC}"
      exit 1
      ;;
    *)
      POSITIONAL_ARGS+=("$1") # save positional arg
      shift # past argument
      ;;
  esac
done

set -- "${POSITIONAL_ARGS[@]}" # restore positional parameters

# Get reference for all important folders
root_dir="$(get_root_dir)"
deployment_dir="$root_dir/deployment"
cdk_out_dir="$root_dir/.build/cdk.out"
global_assets_dir="$deployment_dir/global-s3-assets"
regional_assets_dir="$deployment_dir/regional-s3-assets"
ecr_dir="$deployment_dir/ecr"

# Set defaults from solution-manifest.yaml if parameters not provided
printf "\n%b=== Innovation Sandbox S3 Distribution Builder ===%b\n" "${BOLD}${PURPLE}" "${NC}"
set_solution_params_from_manifest "$root_dir"

# Validate that all required parameters are provided
if [ -z "$DIST_OUTPUT_BUCKET" ] || [ -z "$SOLUTION_NAME" ] || [ -z "$VERSION" ]; then
    printf "%bError: Missing required parameters\n%b" "${RED}" "${NC}"
    printf "%bRequired: --dist-output-bucket, --solution-name, and --version\n%b" "${RED}" "${NC}"
    printf "%bSolution name and version can be provided via CLI or solution-manifest.yaml\n%b" "${YELLOW}" "${NC}"
    printf "\n%bExample usage:\n%b" "${YELLOW}" "${NC}"
    printf "  ./build-s3-dist.sh --dist-output-bucket solutions-bucket\n"
    printf "  ./build-s3-dist.sh --dist-output-bucket solutions-bucket --solution-name my-solution --version v1.0.0\n"
    exit 1
fi


print_step "Preparing Build Environment"
remove_directory "$global_assets_dir"
remove_directory "$regional_assets_dir"
remove_directory "$cdk_out_dir"

ensure_directory "$global_assets_dir"
ensure_directory "$regional_assets_dir"

if [ "$SKIP_BUILD" != "true" ]; then
    print_step "Building TypeScript Packages"
    run_with_status "TypeScript compilation" npm run build
else
    print_warning "Skipping TypeScript build (--skip-build flag provided)"
fi

# Initialize empty context array
CONTEXT_FLAGS=()

# Add context flags only if variables are set
CONTEXT_FLAGS+=("--context" "solutionName=$SOLUTION_NAME")
CONTEXT_FLAGS+=("--context" "version=$VERSION")
CONTEXT_FLAGS+=("--context" "distOutputBucket=$DIST_OUTPUT_BUCKET")
[ -n "$SOLUTION_ID" ] && CONTEXT_FLAGS+=("--context" "solutionId=$SOLUTION_ID")
[ -n "$PUBLIC_ECR_REGISTRY" ] && CONTEXT_FLAGS+=("--context" "publicEcrRegistry=$PUBLIC_ECR_REGISTRY")
[ -n "$PUBLIC_ECR_TAG" ] && CONTEXT_FLAGS+=("--context" "publicEcrTag=$PUBLIC_ECR_TAG")
[ -n "$PRIVATE_ECR_REPO" ] && CONTEXT_FLAGS+=("--context" "privateEcrRepo=$PRIVATE_ECR_REPO")
[ -n "$NUKE_CONFIG_FILE_PATH" ] && CONTEXT_FLAGS+=("--context" "nukeConfigFilePath=$NUKE_CONFIG_FILE_PATH")
[ -n "$LOG_LEVEL" ] && CONTEXT_FLAGS+=("--context" "logLevel=$LOG_LEVEL")
[ -n "$DEPLOYMENT_MODE" ] && CONTEXT_FLAGS+=("--context" "deploymentMode=$DEPLOYMENT_MODE")

print_step "Synthesizing CDK Infrastructure"
run_with_status "CDK synthesis" npm run --workspace @amzn/innovation-sandbox-infrastructure cdk synth -- "${CONTEXT_FLAGS[@]}"

print_step "Processing CloudFormation Templates"
for file in "$cdk_out_dir"/*.template.json; do
    filename=$(basename "$file")
    # Check if filename is in REGIONAL_TEMPLATES array
    if [ "$filename" = "InnovationSandbox-SandboxAccount.template.json" ]; then
        cp "$file" "$regional_assets_dir/$(basename "${file%.json}")"
    else
        cp "$file" "$global_assets_dir/$(basename "${file%.json}")"
    fi
done

print_step "Packaging Lambda Assets"
rsync "$cdk_out_dir"/asset.* "$regional_assets_dir"

print_step "Preparing Container Images"
find "$root_dir/source" -name Dockerfile | while read file; do
    parent_dir="$(basename "$(dirname "$file")")"
    mkdir -p "$ecr_dir/$SOLUTION_NAME-$parent_dir"
    cp "$file" "$ecr_dir/$SOLUTION_NAME-$parent_dir/Dockerfile"
done

print_final_success "S3 distribution build completed successfully!"
printf "\n%bBuild Artifacts:%b\n" "${BOLD}${BLUE}" "${NC}"
printf "%b  Global assets: %b%s%b\n" "${BLUE}" "${WHITE}" "$global_assets_dir" "${NC}"
printf "%b  Regional assets: %b%s%b\n" "${BLUE}" "${WHITE}" "$regional_assets_dir" "${NC}"
printf "%b  Container images: %b%s%b\n" "${BLUE}" "${WHITE}" "$ecr_dir" "${NC}"

printf "\n%bNext Steps - Upload to S3:%b\n" "${BOLD}${BLUE}" "${NC}"
printf "%b  Global assets:%b\n" "${BLUE}" "${NC}"
printf "    aws s3 cp %s s3://%s/%s/%s --recursive\n" "$global_assets_dir" "$DIST_OUTPUT_BUCKET" "$SOLUTION_NAME" "$VERSION"
printf "%b  Regional assets:%b\n" "${BLUE}" "${NC}"
printf "    aws s3 cp %s s3://%s-<region>/%s/%s --recursive\n" "$regional_assets_dir" "$DIST_OUTPUT_BUCKET" "$SOLUTION_NAME" "$VERSION"
printf "%b  NOTE: Replace <region> with your target AWS region (e.g., us-east-1)%b\n" "${YELLOW}" "${NC}"
