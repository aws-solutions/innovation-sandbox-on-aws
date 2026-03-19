#!/bin/bash

# Innovation Sandbox - Deploy All Stacks with Account Confirmation
# This script checks the current AWS account and prompts for confirmation before deploying

set -e

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Innovation Sandbox - Deploy All Stacks${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if AWS CLI is available
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI is not installed or not in PATH${NC}"
    exit 1
fi

# Get current AWS account information
echo -e "${YELLOW}Checking current AWS credentials...${NC}"
echo ""

set +e
ACCOUNT_INFO=$(aws sts get-caller-identity 2>&1)
EXIT_CODE=$?
set -e

if [ $EXIT_CODE -ne 0 ]; then
    echo -e "${RED}Error: Failed to get AWS account information${NC}"
    echo -e "${RED}Please ensure you have valid AWS credentials configured${NC}"
    echo ""
    echo "$ACCOUNT_INFO"
    exit 1
fi

ACCOUNT_ID=$(echo "$ACCOUNT_INFO" | grep -o '"Account": "[^"]*' | cut -d'"' -f4)
USER_ARN=$(echo "$ACCOUNT_INFO" | grep -o '"Arn": "[^"]*' | cut -d'"' -f4)
USER_ID=$(echo "$ACCOUNT_INFO" | grep -o '"UserId": "[^"]*' | cut -d'"' -f4)

# Get current AWS region
CURRENT_REGION=$(aws configure get region 2>/dev/null)
if [ -z "$CURRENT_REGION" ]; then
    # Try to get from environment variable
    CURRENT_REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-"Not set"}}
fi

# Display account information
echo -e "${GREEN}Current AWS Credentials:${NC}"
echo -e "  Account ID: ${YELLOW}${ACCOUNT_ID}${NC}"
echo -e "  Region:     ${YELLOW}${CURRENT_REGION}${NC}"
echo -e "  User ARN:   ${YELLOW}${USER_ARN}${NC}"
echo -e "  User ID:    ${YELLOW}${USER_ID}${NC}"
echo ""

# Load environment variables to show deployment context
if [ -f .env ]; then
    source .env
    echo -e "${GREEN}Deployment Configuration:${NC}"
    echo -e "  Hub Account:              ${YELLOW}${HUB_ACCOUNT_ID:-Not set}${NC}"
    echo -e "  Org Mgt Account:          ${YELLOW}${ORG_MGT_ACCOUNT_ID:-Not set}${NC}"
    echo -e "  IDC Account:              ${YELLOW}${IDC_ACCOUNT_ID:-Not set}${NC}"
    echo -e "  Deployment Mode:          ${YELLOW}${DEPLOYMENT_MODE:-Not set}${NC}"
    echo -e "  Sandbox Account Regions:  ${YELLOW}${AWS_REGIONS:-Not set}${NC}"
    echo ""

    # Check for account mismatches
    MISMATCH_FOUND=false

    if [ -n "$HUB_ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != "$HUB_ACCOUNT_ID" ]; then
        echo -e "${RED}⚠️  WARNING: Current account ($ACCOUNT_ID) does not match HUB_ACCOUNT_ID ($HUB_ACCOUNT_ID)${NC}"
        echo -e "${RED}   The Compute and Data stacks will be deployed to the CURRENT account, not HUB_ACCOUNT_ID${NC}"
        MISMATCH_FOUND=true
    fi

    if [ -n "$ORG_MGT_ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != "$ORG_MGT_ACCOUNT_ID" ]; then
        echo -e "${RED}⚠️  WARNING: Current account ($ACCOUNT_ID) does not match ORG_MGT_ACCOUNT_ID ($ORG_MGT_ACCOUNT_ID)${NC}"
        echo -e "${RED}   The AccountPool stack will be deployed to the CURRENT account, not ORG_MGT_ACCOUNT_ID${NC}"
        MISMATCH_FOUND=true
    fi

    if [ -n "$IDC_ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != "$IDC_ACCOUNT_ID" ]; then
        echo -e "${RED}⚠️  WARNING: Current account ($ACCOUNT_ID) does not match IDC_ACCOUNT_ID ($IDC_ACCOUNT_ID)${NC}"
        echo -e "${RED}   The IDC stack will be deployed to the CURRENT account, not IDC_ACCOUNT_ID${NC}"
        MISMATCH_FOUND=true
    fi

    if [ "$MISMATCH_FOUND" = true ]; then
        echo ""
        echo -e "${RED}⚠️  ACCOUNT MISMATCH DETECTED!${NC}"
        echo -e "${YELLOW}   This typically means you're authenticated to the wrong AWS account.${NC}"
        echo -e "${YELLOW}   Please verify your AWS credentials before proceeding.${NC}"
        echo ""
    fi
else
    echo -e "${YELLOW}Warning: .env file not found. Run 'npm run env:init' to create it.${NC}"
    echo ""
fi

# Display what will be deployed
echo -e "${YELLOW}This will deploy the following stacks:${NC}"
echo -e "  1. InnovationSandbox-AccountPool"
echo -e "  2. InnovationSandbox-IDC"
echo -e "  3. InnovationSandbox-Data"
echo -e "  4. InnovationSandbox-Compute"
echo ""

# Prompt for confirmation
echo -e "${RED}⚠️  This will deploy all Innovation Sandbox stacks to account ${ACCOUNT_ID}${NC}"
echo -e "${YELLOW}Do you want to continue? (y/N)${NC}"
read -r response

if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${YELLOW}Deployment cancelled by user${NC}"
    exit 0
fi

echo ""
echo -e "${GREEN}Starting deployment...${NC}"
echo ""

# Execute the actual deployment
source .env && npm run deploy:account-pool && npm run deploy:idc && npm run deploy:data && npm run deploy:compute

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment completed successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
