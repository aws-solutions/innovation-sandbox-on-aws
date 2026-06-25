---
inclusion: fileMatch
fileMatchPatterns:
  - "source/lambdas/**"
---

# Lambda Handler Patterns

## Handler Structure

Every Lambda uses Middy middleware composition:

```typescript
// API Lambda (with auth, error mapping, security headers)
export const handler = baseMiddlewareBundle({ description: "Handles lease requests" })
  .use(apiMiddlewareBundle({
    requiredGroupMembership: [IsbGroupName.ADMIN],
    globalConfig: IsbServices.globalConfigService(env),
  }))
  .handler(async (event: IsbApiEvent, context) => {
    const { env, user } = context; // type-safe, validated
    // ... business logic using services
    return createJSendSuccess(responseData);
  });

// Event Lambda (SQS/EventBridge, no auth)
export const handler = baseMiddlewareBundle({ description: "Processes lease events" })
  .handler(async (event: SQSEvent, context) => {
    const { env } = context;
    // ...
  });
```

## Middleware Stack

- `baseMiddlewareBundle` — logger (JSON), tracer (X-Ray), environment validation
- `apiMiddlewareBundle` — adds JWT auth, security headers, JSend error conversion
- `configMiddlewareBundle` — adds AppConfig global config to context

Middleware executes in order; each adds to `context` via `Object.assign`.

## Environment Variables

1. Define schema in `source/common/lambda/environments/` extending `BaseLambdaEnvironmentSchema`
2. CDK `IsbLambdaFunction<EnvSchema>` injects and types the env vars
3. Access as `context.env.MY_VAR` — never `process.env`
4. Validation failure throws `EnvironmentValidatorError` → 500 response

## Services Pattern

```typescript
// IsbServices factory builds services from typed environment
const leaseStore = IsbServices.leaseStore(env);
const idcService = IsbServices.idcService(env, credentials); // credentials for cross-account
```

## Error Handling

Throw custom errors from service code — middleware converts them:

| Error Class | HTTP Status |
|---|---|
| `ConcurrentDataModificationException` | 409 |
| `MaxNumberOfLeasesExceededError` | 429 |
| `NoAccountsAvailableError` | 429 |
| `UnknownItem` | 404 |
| `ItemAlreadyExists` | 409 |

Never build HTTP responses in service methods.

## File Layout Per Lambda

```
source/lambdas/my-lambda/
  src/
    my-lambda-handler.ts   # exported handler
    my-service.ts          # business logic
  test/
    my-lambda-handler.test.ts
  package.json
  tsconfig.json
```

## Lambda Configuration (via IsbLambdaFunction)

All Lambdas automatically get:
- Node.js 22 ARM64, 1024MB RAM, 60s timeout (override in props)
- X-Ray tracing always active
- JSON structured logging via Powertools
- KMS-encrypted CloudWatch log group
- Name format: `ISB-{ConstructId}-{namespace}`
