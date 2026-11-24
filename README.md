# Innovation Sandbox on AWS

**[🚀 Solution Landing Page](https://aws.amazon.com/solutions/implementations/innovation-sandbox-on-aws)** | **[🚧 Feature request](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/new?assignees=&labels=enhancement&template=feature_request.md&title=)** | **[🐛 Bug Report](https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/new?assignees=&labels=bug&template=bug_report.md&title=)**

**Note:** If you want to use the solution without building from source, navigate to Solution Landing Page.

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Solution Overview](#solution-overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Environment Variables](#environment-variables)
- [Deploy the Solution](#deploy-the-solution)
  - [Deployment Prerequisites](#deployment-prerequisites)
  - [Deploy from the AWS Console](#deploy-from-the-aws-console)
  - [Deploy from Source](#deploy-from-source)
  - [Post Deployment Tasks](#post-deployment-tasks)
- [Scripts](#scripts)
  - [Machine-to-machine (M2M) authentication](#machine-to-machine-m2m-authentication)
  - [AWS CLI](#aws-cli)
  - [MCP clients](#mcp-clients)
- [Run the Web UI Locally](#run-the-web-ui-locally)
- [Running Tests](#running-tests)
  - [Unit Tests](#unit-tests)
- [Using Private ECR Repositories](#using-private-ecr-repositories)
- [Uninstalling the Solution](#uninstalling-the-solution)
- [Cost Scaling](#cost-scaling)
- [File Structure](#file-structure)
- [Pre-Commit](#pre-commit)
- [Collection of Operational Metrics](#collection-of-operational-metrics)
- [License](#license)
- [Additional Resources](#additional-resources)

## Solution Overview

Innovation Sandbox on AWS enables cloud administrators to provision and recycle temporary AWS sandbox environments with automated security, governance, and cost management. Teams can experiment, learn, and innovate with AWS services in production-isolated accounts that are automatically cleaned up and returned to the pool after use.

Users choose a lease template when requesting a sandbox account through the web UI or API. The template can set a lease duration and budget and enable predictive budget controls. It defines which IAM Identity Center permission sets are available and whether the lease owner can share access. A template can include a blueprint to provision infrastructure in the account. It can also enable Sandbox Spaces, where users chat with an AI agent in the web UI to work in their leased account.

Administrators use global settings to choose which features lease templates can use and whether templates must specify a budget or duration. They also configure account cleanup and notification delivery through Amazon SES, Amazon SNS, or both.

To find out more about Innovation Sandbox on AWS visit our [AWS Solutions](https://aws.amazon.com/solutions/implementations/innovation-sandbox-on-aws)
page.

See the [changelog](./CHANGELOG.md) for release details.

## Architecture

![](./docs/diagrams/architecture/high-level.drawio.svg)

For more details, please refer to the [Architecture Overview](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/architecture-overview.html#architecture-diagram) section of the implementation guide.

## Prerequisites

To build and run the unit tests on macOS or Amazon Linux 2023, install these tools.

- Node 24 and npm 10 or later
- Java 21 (Amazon Corretto 21 recommended)

The repository’s bootstrap and deployment scripts also require the AWS CLI. Installing the repository dependencies provides the CDK CLI.

**Optional development tools**

- Python 3 for the `aws isb` CLI installer. The MCP helper requires Python 3.10 or later.
- pre-commit to run the repository’s [Git hooks](#pre-commit).
- Docker to build the account cleaner or Sandbox Spaces agent runtime [container images](#using-private-ecr-repositories).

Install dependencies and build from the repository root.

```shell
npm install
```

```shell
npm run build
```

The source distribution intentionally includes the bootstrap manifests for `source/api-client` and `source/api-server`. The build generates and compiles both packages from the [Smithy API model](./source/api-model/README.md).

## Environment Variables

For deployment or local frontend development, configure an environment file from the repository root. The [example file](./.env.example) lists the settings for each stack.

For a standalone configuration, create `.env` from `.env.example`.

```shell
npm run env:init
```

For a named configuration, choose a name such as `dev` and create `dev.env` from the same example.

```shell
npm run env:init -- dev
```

Activate it by linking `.env` to `dev.env`. If `.env` is already a regular file, move it to an unused name ending in `.env` first.

```shell
npm run env:use -- dev
```

Check which named environment is active or whether `.env` is unmanaged.

```shell
npm run env:current
```

Edit the active `.env` with your deployment values. All `*.env` files are gitignored.

## Deploy the Solution

### Deployment Prerequisites

The solution requires several prerequisite steps before attempting to deploy the solution. See the [implementation guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/prerequisites.html) for more details.

### Deploy from the AWS Console

| Stack        |                                                                                                          CloudFormation Launch Link                                                                                                           |                                                         S3 Download Link                                                         |
| ------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------: |
| Account Pool | [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-AccountPool.template&redirectId=GitHub) | [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-AccountPool.template) |
| IDC          |     [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-IDC.template&redirectId=GitHub)     |     [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-IDC.template)     |
| Data         |    [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Data.template&redirectId=GitHub)     |    [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Data.template)     |
| Compute      |   [Launch](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/new?&templateURL=https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Compute.template&redirectId=GitHub)   |   [Download](https://solutions-reference.s3.amazonaws.com/innovation-sandbox-on-aws/latest/InnovationSandbox-Compute.template)   |

### Deploy from Source

Configure the AWS CLI with credentials for the target accounts. For a multi-account deployment, set `ORG_MANAGEMENT_ACCOUNT_PROFILE` (Account Pool), `IDC_ACCOUNT_PROFILE` (IDC), and `HUB_ACCOUNT_PROFILE` (Data and Compute) in `.env`. An unset profile uses the current credentials.

Bootstrap the target accounts in `DEPLOY_REGION` before the first CDK deployment.

```shell
npm run bootstrap
```

Deploy all four stacks in order using the configured profiles.

```shell
npm run deploy:all
```

To deploy an individual stack, choose its command.

```shell
npm run deploy:account-pool
```

```shell
npm run deploy:idc
```

```shell
npm run deploy:data
```

```shell
npm run deploy:compute
```

### Post Deployment Tasks

Before the solution is fully functional the post deployment tasks must be completed. See the [implementation guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/post-deployment-configuration-tasks.html) for more details.

## Scripts

### Machine-to-machine (M2M) authentication

Use M2M authentication for scripts, CI jobs, and integrations with your own services. Each client assumes its own IAM role and uses the temporary credentials to sign API requests with SigV4. See the [M2M authentication scripts](./scripts/m2m/README.md).

### AWS CLI

To call the API from the terminal, use AWS CLI v2.13.0 or later, install the `aws isb` commands, and configure your deployment endpoint. Run the commands with credentials from your client's M2M role. The M2M scripts can save those credentials to a named profile. See the [AWS CLI setup guide](./scripts/m2m/aws-cli/README.md).

### MCP clients

To use Innovation Sandbox tools from an MCP client, sign in with your usual Innovation Sandbox account. The helper requires Python 3.10 or later and `uv`. See the [MCP setup guide](./scripts/mcp/README.md).

## Run the Web UI Locally

Use a development deployment created with `DEPLOYMENT_MODE=dev` so Cognito accepts the localhost sign-in callback. After building, start the dev server from the repository root.

```shell
npm run dev --workspace source/frontend
```

Open `http://localhost:5173`. The dev server proxies API calls to your deployment. See the [frontend setup](./source/frontend/README.md) for proxy settings.

## Running Tests

### Unit Tests

From the repository root, run the Vitest suite with coverage. This also prepares the generated API packages.

```shell
npm test
```

If a change intentionally alters the expected output, update the Vitest snapshots after building.

```shell
npm run test:update-snapshots
```

## Using Private ECR Repositories

Source deployments use public images by default. To test changes to the account cleaner or Sandbox Spaces agent runtime, start Docker with BuildKit enabled and use private ECR repositories in your Hub account.

1. In `.env`, set `PRIVATE_ACCOUNT_CLEANER_ECR_REPO` or `PRIVATE_SANDBOX_AGENT_RUNTIME_ECR_REPO` for the image you want to build. To build both, use separate repository names. The Docker commands use `HUB_ACCOUNT_PROFILE` when set and the AWS CLI default credential chain otherwise.
1. From the repository root, run the command for the image you configured.

   **Account cleaner**

   ```shell
   npm run docker:build-and-push -- account-cleaner
   ```

   **Sandbox Spaces agent runtime**

   ```shell
   npm run docker:build-and-push -- sandbox-agent-runtime
   ```

   If you configured both repositories, you can build and push both images together.

   ```shell
   npm run docker:build-and-push
   ```

   The `docker:build` and `docker:push` scripts accept the same targets and default to both images.
   Before pushing an image, the push command creates its private ECR repository in the Hub account and `DEPLOY_REGION` if it does not already exist. Automatic creation requires `ecr:DescribeRepositories` and `ecr:CreateRepository`; credentials with push-only access can still push to an existing repository.

1. If you have already deployed the solution, deploy the compute stack again to use the private ECR images:

   ```shell
   npm run deploy:compute
   ```

   The deploy script pins the private runtime image by digest. If ECR lacks an image tagged for the current source, the script builds and pushes it first. To fail if the image is missing, use this command.

   ```shell
   npm run deploy:compute -- --skip-image-build
   ```

## Uninstalling the Solution

Before deleting stacks, end leases, eject accounts, and complete the other steps in the [uninstall guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/uninstall-the-solution.html). For a source deployment, this command deletes the four solution stacks in reverse deployment order.

```shell
npm run destroy:all
```

To remove individual stacks, choose the corresponding commands in this order.

```shell
npm run destroy:compute
```

```shell
npm run destroy:data
```

```shell
npm run destroy:idc
```

```shell
npm run destroy:account-pool
```

## Cost Scaling

This solution incurs cost for both the solution infrastructure and any activity that occurs within the sandbox accounts. Cost will vary greatly based on sandbox account usage.

For more details on solution infrastructure cost estimation see the [implementation guide](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/cost.html).

## File Structure

```
root
├── deployment/                     # shell scripts to generate native cloudformation distributables
│   ├── global-s3-assets                # generated dist files for cdk synthesized cloudformation templates
│   ├── regional-s3-assets              # generated dist files for zipped runtime assets such as lambda functions
│   └── build-s3-dist.sh                # builds solution into distributable assets that can be deployed with cloudformation
├── docs/                           # architecture diagrams, OpenAPI specification, and AWS CLI model
├── scripts/                        # CDK, Docker, environment, M2M, and MCP tools
├── source/                         # source code separated into multiple stand alone packages
│   ├── agent-runtime                   # Sandbox Spaces agent
│   ├── api-model                       # Smithy model for the API client and server bindings
│   ├── common                          # shared backend libraries
│   ├── shared                          # types and utilities shared with the frontend
│   ├── frontend                        # frontend vite application
│   ├── infrastructure                  # cdk application consisting of solution infrastructure
│   ├── lambdas                         # lambda function runtime code, contains multiple lambdas each of which is its own package
│   └── layers                          # lambda layers, contains multiple layers each of which is its own package
├── .pre-commit-config.yaml         # pre-commit hook configurations
└── package.json                    # top level npm package.json file with scripts to serve as orchestrated monorepo commands
```

## Pre-Commit

This repository uses pre-commit. Pre-commit is a framework for managing and maintaining multi-language pre-commit hooks which are scripts that run every time you make a commit. This offers automated checks with quick feedback cycles that enable code reviewers to focus on architecture and design rather than syntax and style.

To install the hooks, run the following commands:

```shell
# this installs the pre-commit package manager
pip install pre-commit
```

```shell
# this will install the hook scripts contained in the .pre-commit-config.yaml file
pre-commit install
```

Once installed pre-commit hooks will be ran on each commit preventing commits that do not pass the configured checks. Certain hooks will automatically alter and reformat code so that you don't have to.

If you would like to run the hooks without making a commit, run the following command.

```shell
pre-commit run --all-files
```

For more information on pre-commit, refer to the official documentation [here](https://pre-commit.com/).

## Collection of Operational Metrics

This solution sends operational metrics to AWS (the “Data”) about the use of this solution. We use this Data to better understand how customers use this solution and related services and products. AWS’s collection of this Data is subject to the [AWS Privacy Notice](https://aws.amazon.com/privacy/).

## License

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License Version 2.0 (the "License"). You may not use this file except
in compliance with the License. A copy of the License is located at http://www.apache.org/licenses/
or in the "[LICENSE](./LICENSE)" file accompanying this file. This file is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the
specific language governing permissions and limitations under the License.

## Additional Resources

- [AWS Solutions Library](https://aws.amazon.com/solutions/)
- [AWS CloudFormation Documentation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html)
- [AWS CloudFormation StackSets Documentation](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
- [AWS Account Management](https://docs.aws.amazon.com/accounts/latest/reference/accounts-welcome.html)
- [AWS Nuke Repository](https://github.com/ekristen/aws-nuke)
