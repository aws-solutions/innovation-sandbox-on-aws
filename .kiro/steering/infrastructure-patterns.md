---
inclusion: fileMatch
fileMatchPatterns:
  - "source/infrastructure/**"
---

# CDK Infrastructure Patterns

## Construct Hierarchy

```
IsbComputeStack (extends Stack)
  └── IsbComputeResources (plain class, not a Construct)
        ├── IsbLambdaFunction<EnvSchema>    ← custom L2 wrapper
        ├── IsbApiGateway
        └── IsbEventBridge
```

Resource classes group related infrastructure but do **not** extend `Construct`:

```typescript
export class IsbComputeResources {
  readonly api: IsbApiGateway;
  readonly lambdas: Record<string, IsbLambdaFunction<...>>;

  constructor(scope: Construct, props: IsbComputeResourcesProps) {
    this.api = new IsbApiGateway(scope, "Api", { ... });
  }
}
```

Stacks instantiate resource classes, passing `this` as scope.

## IsbLambdaFunction (Use This for All Lambdas)

```typescript
const myLambda = new IsbLambdaFunction(this, "MyLambda", {
  description: "...",
  entry: path.join(__dirname, "../../../lambdas/my-lambda/src/handler.ts"),
  environmentSchema: MyLambdaEnvironmentSchema,
  environment: {
    TABLE_NAME: table.tableName,
  },
  // Override defaults if needed:
  // memorySize: 2048,
  // timeout: Duration.minutes(5),
});
```

Provides: KMS log encryption, Powertools env vars, X-Ray tracing, JSON logs, ARM64/Node22, type-safe env schema injection.

## Stack Naming & Namespacing

All resource logical IDs and physical names include the namespace prefix:
```typescript
const tableName = `${namespace}-leases`;
const functionName = `ISB-LeaseMonitor-${namespace}`;
```

This allows multiple deployments in the same account.

## Compliance & Security

```typescript
// Suppress a specific cfn-guard rule with justification
addCfnGuardSuppression(resource, "W1", "Justified because...");
```

Never disable encryption, versioning, or access controls — suppress only when truly required.

## StackSets for Multi-Account

Account-level controls (SCPs, OU structure) deploy via CloudFormation StackSets with auto-deployment enabled. Use `CfnStackSet` from `aws-cdk-lib/aws-cloudformation`.

## Synthesizer

Uses `SolutionsEngineeringSynthesizer` — assets land in regional/global S3 buckets, not CDK bootstrap buckets. Don't switch to the default synthesizer.

## Asset Handling

Lambda code is bundled by esbuild (via `NodejsFunction` inside `IsbLambdaFunction`):
- Source maps enabled (`sourceMap: true`)
- Output: zipped bundle in S3 asset bucket
- CDK snapshot tests normalize the content hash to `"Omitted to remove snapshot dependency on hash"`

## Props Interface Patterns

```typescript
interface IsbComputeResourcesProps extends IsbBaseResourcesProps {
  readonly dataResources: IsbDataResources;
  readonly namespace: string;
}
```

Extend from base props interfaces to compose shared settings.
