# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install             # install all workspace dependencies
npm test                # run all tests with coverage (vitest)
npm run test:update-snapshots  # update CDK snapshot tests
npm run build           # typecheck all workspaces (no emit)

# Run tests for a single package
npm test --workspace @amzn/innovation-sandbox-commons
npm test --workspace @amzn/innovation-sandbox-infrastructure
npm test --workspace @amzn/innovation-sandbox-frontend

# Environment setup (required before deploying)
npm run env:init        # creates .env from .env.example

# Deployment (requires .env configured)
npm run bootstrap       # CDK bootstrap target accounts
npm run deploy:all      # single-account deployment
npm run deploy:account-pool | deploy:idc | deploy:data | deploy:compute

# Clean workspace
npm run clean           # git clean -dfX (preserves .env)
```

## Architecture Overview

This is an AWS Solutions Library product that provisions and recycles temporary sandbox AWS accounts. It deploys as **4 separate CloudFormation stacks** designed for multi-account deployment:

| Stack | Account | Key Resources |
|---|---|---|
| `AccountPool` | Org management | Organizations OUs, SCPs, sandbox account pool |
| `IDC` | IDC account | IAM Identity Center groups (Admin/Manager/User) |
| `Data` | Hub | DynamoDB tables, AppConfig (global config) |
| `Compute` | Hub | API Gateway, Lambdas, EventBridge, Step Functions, CloudFront |

## Monorepo Structure

npm workspaces with all packages under `source/`:

- `source/common` (`@amzn/innovation-sandbox-commons`) — shared data models, Zod schemas, DynamoDB stores, service layer, EventBridge event types. This is imported by lambdas, infrastructure, and frontend.
- `source/frontend` (`@amzn/innovation-sandbox-frontend`) — Vite/React UI served via CloudFront
- `source/infrastructure` (`@amzn/innovation-sandbox-infrastructure`) — CDK app defining all 4 stacks
- `source/lambdas/**` — individual Lambda function packages (each is its own workspace)
- `source/layers/**` — Lambda layers (each is its own workspace)

## Domain Model

The core business object is a **Lease** — a temporary grant of a sandbox AWS account to a user.

**Lease lifecycle:** `PendingApproval` → `Provisioning` → `Active` / `Frozen` → terminal (`Expired`, `BudgetExceeded`, `ManuallyTerminated`, `AccountQuarantined`, `ProvisioningFailed`, `Ejected`, `ApprovalDenied`)

**Sandbox account OU states** mirror the lease lifecycle: `Available` → `Active` → `CleanUp` → `Quarantine`/`Frozen` → `Available`

**`InnovationSandbox` class** (`source/common/innovation-sandbox.ts`) is the central orchestrator — it implements all lease lifecycle operations (request, approve, deny, freeze, terminate, etc.) and is used by multiple lambdas.

## Key Patterns

**Data layer:** All entities (Lease, SandboxAccount, LeaseTemplate, Blueprint) use Zod schemas for validation and type inference. Schema versioning is built in — bump `*SchemaVersion` constants whenever a schema changes. DynamoDB stores implement a consistent store pattern (`*Store` classes in `source/common/data/`).

**Event-driven async:** Most cross-service workflows are driven by EventBridge events (defined in `source/common/events/`). Lambda handlers in `source/lambdas/` subscribe to events via SQS queues.

**API response format:** All REST API responses use JSend (`{ status: "success"|"fail"|"error", data: ... }`).

**Namespace:** All AWS resources are namespaced (e.g., `myisb`) to support parallel deployments in the same account.

**Account cleanup:** When a lease ends, accounts are cleaned using **aws-nuke** built from source in a Docker container (`source/infrastructure/lib/components/account-cleaner/Dockerfile`) run in CodeBuild, orchestrated by a Step Functions state machine.

## Development Mode

Set `DEPLOYMENT_MODE=dev` in `.env` to disable deletion protection on DynamoDB tables and CloudFormation stacks, and use `RemovalPolicy.DESTROY`.

## Lambda Handler Pattern

All Lambda handlers use Middy middleware via factory functions:

```typescript
// API handlers (authentication, validation, error mapping, security headers)
export const handler = baseMiddlewareBundle({ description: "..." })
  .use(apiMiddlewareBundle({ ... }))
  .handler(async (event, context) => {
    // context.env — type-safe validated environment (never use process.env)
    // context.user — authenticated user from JWT
    return createJSendSuccess(data);
  });

// Event handlers (SQS/EventBridge)
export const handler = baseMiddlewareBundle({ description: "..." })
  .handler(async (event, context) => { ... });
```

Handler files live at `src/*-handler.ts` in each Lambda workspace. Lambda environments are defined as Zod schemas in `source/common/lambda/environments/` and injected via `IsbLambdaFunction` in CDK. Use `context.env.VAR_NAME` — never `process.env` directly.

## Error Handling

Custom error hierarchy (`source/common/errors.ts`):
- `InnovationSandboxError` — base class
- Domain: `NoAccountsAvailableError`, `MaxNumberOfLeasesExceededError`, `AccountInCleanUpError`
- Data: `ConcurrentDataModificationException`, `UnknownItem`, `ItemAlreadyExists`
- Middleware: `EnvironmentValidatorError`, `InvalidGlobalConfiguration`

Throw custom errors from services — `httpErrorHandler` middleware maps them to HTTP codes (409 for concurrent modifications, 429 for throttling). Never convert errors to HTTP responses in service code.

## Testing Patterns

Tests use Vitest. Key utilities in `source/common/test/`:
- `createAPIGatewayProxyEvent()` — builds API Gateway test events
- `mockAuthorizedContext()` — provides authenticated Lambda context with `context.env`
- `generateSchemaData()` — creates valid test data from Zod schemas
- `bulkStubEnv()` — stubs multiple environment variables at once
- `mockAppConfigMiddleware()` — stubs the global config middleware

Use `aws-sdk-client-mock` for AWS SDK mocking. In `afterEach`: call `vi.resetAllMocks()` and `vi.unstubAllEnvs()` and `mockClient.reset()`.

CDK snapshot tests normalize Lambda code hashes (replace with `"Omitted to remove snapshot dependency on hash"`). Run `npm run test:update-snapshots` after intentional infrastructure changes.

Set `POWERTOOLS_TRACE_ENABLED=false` and `AWS_XRAY_CONTEXT_MISSING=IGNORE_ERROR` in vitest env to suppress X-Ray errors.

## CDK Patterns

Use `IsbLambdaFunction<T>` (`source/infrastructure/lib/constructs/isb-lambda-function.ts`) for all Lambdas — it wires KMS log encryption, Powertools, X-Ray tracing (always active), JSON logging, and env var injection automatically. All Lambdas run Node.js 22 ARM64, 1024MB memory, 1min timeout.

Resource classes (not extending Construct) group related infrastructure:
```typescript
class IsbComputeResources {
  constructor(scope: Construct, props: IsbComputeResourcesProps) { ... }
}
```
Stacks instantiate resource classes, passing the stack as `scope`.

Use `addCfnGuardSuppression()` to suppress compliance rule exceptions with justification — never remove protections.

## TypeScript

Strict mode plus: `noUncheckedIndexedAccess` (array access returns `T | undefined`), `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`. Module type is `"module"` (ESM) with `NodeNext` resolution. `npm run build` is type-check only (`tsc --noEmit`) — bundling happens via CDK esbuild at deploy time.

## DynamoDB Patterns

Optimistic concurrency: pass `expected: { lastEditTime }` to update operations — throws `ConcurrentDataModificationException` on mismatch. Pagination tokens are base64-encoded composite keys (`base64EncodeCompositeKey()`). Strip null fields before writes with `removeNullFieldsForDynamoDB()`. All entities get `createdTime`, `lastEditTime`, `schemaVersion` metadata via the `@withMetadata()` decorator.

## Gotchas

- EventBridge source must be exactly `InnovationSandbox-{namespace}` — no spaces or special chars in namespace
- Bump `*SchemaVersion` constants whenever any Zod schema changes
- JWT secret uses 60s TTL cache (not default 5s) — users may see 403 during monthly rotation
- Schema discriminated unions handle backwards compatibility for multiple schema versions in DynamoDB
- Docker commands (`npm run docker:build/push`) are needed for the account-cleaner CodeBuild project

## Pre-commit Hooks

All `.ts`/`.tsx` files require the Apache-2.0 license header (auto-inserted by pre-commit). Run `pre-commit run --all-files` to validate or auto-fix. Prettier is enforced with import sort order: `@amzn/*` imports before relative imports. Additional checks: `shellcheck`, `check-yaml`, `check-json`, `detect-private-key`, `detect-empty-files`.
