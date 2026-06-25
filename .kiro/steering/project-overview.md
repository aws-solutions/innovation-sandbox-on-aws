---
inclusion: always
---

# Innovation Sandbox on AWS — Project Overview

## What This Is

An AWS Solutions Library product that provisions and recycles temporary sandbox AWS accounts for engineers. Core concept: a **Lease** grants a user temporary access to a sandbox AWS account, then the account is automatically cleaned and returned to the pool.

## 4-Stack Multi-Account Architecture

| Stack | Account | Key Resources |
|---|---|---|
| `AccountPool` | Org management | Organizations OUs, SCPs, sandbox account pool |
| `IDC` | IDC account | IAM Identity Center groups (Admin/Manager/User) |
| `Data` | Hub | DynamoDB tables, AppConfig (global config) |
| `Compute` | Hub | API Gateway, Lambdas, EventBridge, Step Functions, CloudFront |

## Monorepo Layout

```
source/
  common/        @amzn/innovation-sandbox-commons  — shared schemas, stores, services, events
  frontend/      @amzn/innovation-sandbox-frontend  — Vite/React UI
  infrastructure/ @amzn/innovation-sandbox-infrastructure — CDK app (all 4 stacks)
  lambdas/*/     individual Lambda function workspaces
  layers/*/      Lambda layer workspaces
```

## Lease Lifecycle

```
PendingApproval → Provisioning → Active ↔ Frozen → Expired / BudgetExceeded /
ManuallyTerminated / AccountQuarantined / ProvisioningFailed / Ejected / ApprovalDenied
```

Sandbox account OU states mirror this: `Available → Active → CleanUp → Quarantine/Frozen → Available`

`InnovationSandbox` class (`source/common/innovation-sandbox.ts`) orchestrates all lifecycle transitions.

## Core Rules

- **All responses:** JSend format `{ status: "success"|"fail"|"error", data: ... }`
- **All resources:** namespaced (e.g., `myisb`) to allow parallel deployments in the same account
- **All schemas:** Zod with schema versioning — bump `*SchemaVersion` when schema changes
- **All Lambda env vars:** defined as Zod schemas, accessed via `context.env.VAR` (never `process.env`)
- **Event-driven async:** cross-service workflows via EventBridge → SQS → Lambda
- **Account cleanup:** aws-nuke in CodeBuild Docker container, orchestrated by Step Functions

## Key Technology Choices

- TypeScript ESM with `NodeNext` module resolution, strict mode + `noUncheckedIndexedAccess`
- Node.js 22 ARM64 for all Lambdas (1024MB, 1min timeout)
- Middy middleware for Lambda handler composition
- Vitest for testing, aws-sdk-client-mock for AWS SDK mocking
- CDK with esbuild bundling (type-check is `tsc --noEmit` only)
- `DEPLOYMENT_MODE=dev` disables deletion protection and uses `RemovalPolicy.DESTROY`
