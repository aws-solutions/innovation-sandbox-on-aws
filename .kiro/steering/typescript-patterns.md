---
inclusion: fileMatch
fileMatchPatterns:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript Patterns

## Compiler Settings

All workspaces inherit from root `tsconfig.json`:
- `strict: true` — full strict mode
- `noUncheckedIndexedAccess: true` — array/object index access returns `T | undefined`
- `noImplicitOverride: true` — must use `override` keyword
- `noUnusedLocals: true` / `noUnusedParameters: true` — no dead code
- `moduleResolution: "NodeNext"` + `module: "NodeNext"` — ESM only
- `target: "ES2022"`

All packages use `"type": "module"` in `package.json` — use `.js` extensions in relative imports.

## Zod Schema Pattern

```typescript
// 1. Define schema with version constant
export const LeaseSchemaVersion = 3; // bump when schema changes

export const ActiveLeaseSchema = z.object({
  status: z.literal("Active"),
  userEmail: z.string().email(),
  uuid: z.string().uuid(),
  meta: LeaseMetaSchema,
});

// 2. Infer type from schema — never write types manually for entity shapes
export type ActiveLease = z.infer<typeof ActiveLeaseSchema>;

// 3. Discriminated unions for lifecycle-varied shapes
export const LeaseSchema = z.discriminatedUnion("status", [
  ActiveLeaseSchema,
  FrozenLeaseSchema,
  PendingApprovalLeaseSchema,
  // ...
]);
export type Lease = z.infer<typeof LeaseSchema>;
```

## Type Guards

```typescript
// Use `is` predicate functions for runtime narrowing
function isActiveLease(lease: Lease): lease is ActiveLease {
  return lease.status === "Active";
}
```

## Import Order (enforced by Prettier + import-sort)

```typescript
// 1. Node built-ins
import path from "path";

// 2. External packages
import { z } from "zod";

// 3. @amzn/* internal packages (before relative)
import { LeaseSchema } from "@amzn/innovation-sandbox-commons/lease-schema.js";

// 4. Relative imports
import { createLease } from "./lease-service.js";
```

## ESM Import Extensions

Always use `.js` extension for relative imports (even for `.ts` source files — TypeScript resolves them):

```typescript
// ✅ Correct
import { helper } from "./utils.js";

// ❌ Wrong
import { helper } from "./utils";
```

## Apache License Header (Required)

Every `.ts`/`.tsx` file must start with:

```typescript
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
```

Pre-commit hook auto-inserts this. Running `pre-commit run --all-files` fixes missing headers.

## Naming Conventions

- Files: `kebab-case.ts` (e.g., `lease-monitoring-handler.ts`)
- Classes: `PascalCase`
- Interfaces/Types: `PascalCase` (no `I` prefix)
- Constants/Schema versions: `UPPER_SNAKE_CASE` or `PascalCaseSchemaVersion`
- Zod schemas: `PascalCaseSchema`, inferred types: `PascalCase`

## No `any`

Strict mode prevents `any`. Use `unknown` + type guards for truly dynamic data. Zod's `z.unknown()` for schema positions that accept anything.
