---
inclusion: fileMatch
fileMatchPatterns:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "**/test/**"
  - "**/vitest.config.ts"
---

# Testing Patterns

## Framework & Configuration

Vitest for all tests. Root `vitest.config.ts` uses the `projects` pattern — each workspace has its own `vitest.config.ts`. Run per-workspace: `npm test --workspace @amzn/innovation-sandbox-commons`.

## Test Utilities (source/common/test/)

```typescript
// API Gateway event builder
const event = createAPIGatewayProxyEvent({
  method: "POST",
  path: "/leases",
  body: JSON.stringify(payload),
  headers: { Authorization: `Bearer ${token}` },
});

// Pre-configured authenticated Lambda context
const context = mockAuthorizedContext({ env: { TABLE_NAME: "test-table" } });

// Generate valid test data from a Zod schema
const lease = generateSchemaData(LeaseSchema);

// Stub multiple environment variables at once
bulkStubEnv({ TABLE_NAME: "test-table", NAMESPACE: "test" });

// Stub AppConfig middleware (prevent real AWS calls)
mockAppConfigMiddleware({ maxLeaseDurationHours: 24 });
```

## AWS SDK Mocking

```typescript
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => ddbMock.reset());

it("saves a lease", async () => {
  ddbMock.on(PutCommand).resolves({});
  // ...
});
```

## Standard Cleanup Pattern

```typescript
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  mockClient.reset(); // if using aws-sdk-client-mock
});
```

## Powertools in Tests

Always set these in vitest env config to suppress tracing/X-Ray errors:
```typescript
// vitest.config.ts
env: {
  POWERTOOLS_TRACE_ENABLED: "false",
  AWS_XRAY_CONTEXT_MISSING: "IGNORE_ERROR",
}
```

## Snapshot Tests (CDK Infrastructure)

Snapshots capture the full CloudFormation template. Non-deterministic values that must be normalized:
- Lambda code asset hashes: replace with `"Omitted to remove snapshot dependency on hash"`
- S3 asset keys: normalize similarly
- Auto-increment IDs: replace with static values

After intentional infrastructure changes: `npm run test:update-snapshots`

## Frontend Testing (MSW)

```typescript
// Mock HTTP API with Mock Service Worker
import { http, HttpResponse } from "msw";
const handlers = [
  http.get("/api/leases", () => HttpResponse.json({ status: "success", data: [...] })),
];
```

## Test File Layout

```
source/lambdas/my-lambda/
  src/handler.ts
  test/handler.test.ts   ← colocated, not in separate __tests__
```

## What to Test

- Lambda handler: test happy path + each error case (custom error → HTTP status mapping)
- Services: test business logic with mocked stores
- Stores: test DynamoDB conditional expressions, optimistic locking, pagination
- CDK stacks: snapshot tests + specific resource assertions
