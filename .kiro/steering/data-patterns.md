---
inclusion: fileMatch
fileMatchPatterns:
  - "source/common/data/**"
  - "source/common/*store*"
  - "source/common/*Store*"
  - "source/lambdas/**/src/*store*"
---

# Data Layer Patterns

## Store Architecture

All entity stores implement a consistent interface pattern (`*Store` classes in `source/common/data/`). Stores use DynamoDB Document Client and return paginated results.

```typescript
class LeaseStore {
  async getLease(userEmail: string, uuid: string): Promise<Lease | undefined>
  async createLease(lease: NewLease): Promise<Lease>
  async updateLease(lease: Lease, expected?: { lastEditTime: string }): Promise<Lease>
  async listLeases(options?: ListOptions): Promise<PaginatedResult<Lease>>
}
```

## DynamoDB Key Structure

- **PK**: `userEmail` (partition key)
- **SK**: `uuid` (sort key)
- **GSIs**: query by status (`StatusIndex`), by template UUID

## Optimistic Concurrency Control

**Always** use the `expected` parameter for updates to prevent lost updates:

```typescript
// Fetch the current item (captures lastEditTime)
const current = await store.getLease(email, uuid);

// Update with optimistic lock — throws ConcurrentDataModificationException if changed
const updated = await store.updateLease(
  { ...current, status: "Active" },
  { lastEditTime: current.meta.lastEditTime }
);
```

Retry at the handler level or surface `ConcurrentDataModificationException` as 409 to the client.

## Pagination

```typescript
const result = await store.listLeases({ nextPageIdentifier: req.query.cursor });
// result.items: Lease[]
// result.nextPageIdentifier: string | undefined (base64-encoded composite key)
```

Pagination tokens are base64-encoded `LastEvaluatedKey` values — never expose raw DynamoDB keys.

## Item Metadata

All DynamoDB items get auto-populated metadata via the `@withMetadata()` decorator:

```typescript
interface ItemMeta {
  createdTime: string;     // ISO 8601
  lastEditTime: string;    // ISO 8601 — used for optimistic locking
  schemaVersion: number;   // matches *SchemaVersion constant
}
```

## Null Field Handling

DynamoDB does not allow null attribute values. Strip before writes:

```typescript
const cleaned = removeNullFieldsForDynamoDB(item);
await ddb.send(new PutCommand({ Item: cleaned }));
```

## Conditional Expressions

```typescript
// Create — fail if already exists
ConditionExpression: "attribute_not_exists(userEmail)"

// Update with optimistic lock
ConditionExpression: "meta.lastEditTime = :expectedTime"
ExpressionAttributeValues: { ":expectedTime": expected.lastEditTime }
```

## Schema Versioning

When a Zod schema changes in a breaking way:
1. Bump the `*SchemaVersion` constant (e.g., `LeaseSchemaVersion = 4`)
2. Add the old schema version to the discriminated union for backwards compatibility
3. Handle migration in the store's read path

Existing DynamoDB items retain their old `schemaVersion` — stores must handle all supported versions.

## Transaction Pattern

For multi-table operations that must succeed together:

```typescript
const tx = new Transaction();
tx.add(() => store1.createItem(item1));
tx.add(() => store2.updateItem(item2));
await tx.commit(); // auto-rollback on failure
```
