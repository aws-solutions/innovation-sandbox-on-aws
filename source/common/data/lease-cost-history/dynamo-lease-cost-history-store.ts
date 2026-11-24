// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  paginateQuery,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

import { base64DecodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  BEDROCK_TOKEN_SK_PREFIX,
  BREACH_SK_PREFIX,
  COST_SK_PREFIX,
  LeaseCostHistoryKey,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-keys.js";
import {
  AuditedWindowQueryResult,
  CostHistoryPageIdentifierSchema,
  CostHistoryPageOptions,
  encodeCostHistoryPageIdentifier,
  InvalidCostHistoryPageIdentifierError,
  LeaseCostHistoryStore,
  NewestRecordResult,
  PagedQueryResult,
  RecentCostObservationsResult,
  WindowedQueryResult,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import {
  BedrockTokenRow,
  BedrockTokenRowSchema,
  BedrockTokenSkSchema,
  BreachRecord,
  BreachRecordSchema,
  CostObservation,
  CostObservationSchema,
  IsoMillisSchema,
  LeaseCostHistorySchemaVersion,
  LeaseCostHistorySupportedVersionsSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  datetimeAsString,
  now,
  nowAsIsoDatetimeString,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import type { DroppedRecordReason } from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { z } from "zod";

const logger = new Logger();

/**
 * Conditional writes tried before a breach append gives up. Callers await each
 * append, so a collision means another writer (Lease Monitoring or the token
 * poll) or this run's previous append already took that millisecond for the
 * lease. Each retry takes a fresh millisecond strictly later than the one that
 * collided, so the bound is on DynamoDB work, never on a spin. Exported so the
 * retry-exhaustion test cannot drift from it.
 */
export const BREACH_SK_ATTEMPTS = 3;

/**
 * Rows one read may request, whether as a page or as a bounded lookback. A
 * backstop only: the server-enforced bound belongs on the API's own query
 * string, and the handler that owns it does not exist yet.
 */
const MAX_PAGE_SIZE = 1000;

function assertRowCountInRange(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error(
      `${name} must be an integer between 1 and ${MAX_PAGE_SIZE}; got a value outside that range.`,
    );
  }
}

/**
 * Both bounds are validated and an inverted window throws, because `BETWEEN`
 * matches nothing when `from > to` and an empty result is indistinguishable from a
 * lease that never breached. A short bound is rejected for the same reason the sort
 * keys are regex-pinned: `BREACH#<date>` sorts below `BREACH#<date>T00:00:00.000Z`,
 * dropping the boundary day.
 */
function assertWindowBounds(window: { from: string; to: string }): void {
  const bounds = z
    .object({ from: IsoMillisSchema, to: IsoMillisSchema })
    .safeParse(window);
  if (!bounds.success) {
    throw new Error(
      "Window query needs both bounds as fixed-width ISO millisecond timestamps.",
    );
  }
  if (window.from > window.to) {
    throw new Error(
      "Window query was given an inverted window (from > to); reads here are newest-first, so a page's first element is its newest.",
    );
  }
}

/** 1 MB pages drained for one unpaginated window before the read gives up. */
const WINDOW_QUERY_MAX_PAGES = 20;

/**
 * Bytes accumulated for one unpaginated window before the read gives up. Bounds
 * what the page cap alone does not: 20 pages is up to 20 MB resident in a Lambda
 * that sizes its memory for a fleet scan, not for one caller-chosen window.
 */
const WINDOW_QUERY_MAX_BYTES = 4_000_000;

/**
 * Bytes of token rows one page takes before it stops short, in JSON bytes summed
 * per row, since the response carries a page's rows flattened to one series row
 * per region and model.
 */
const TOKEN_WINDOW_MAX_BYTES = 1_000_000;

/**
 * Recursive, not top-level: zod 4 keeps an explicitly-undefined optional key, and
 * BreachInsightSchema carries two of them a level down, so a top-level filter
 * alone lets the PutCommand reject the write.
 */
function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep);
  }
  // Plain objects only. Rebuilding a class instance from its own enumerable
  // properties silently mangles it -- a Date becomes `{}`, a Buffer becomes a
  // digit-keyed map -- and `put` takes `Record<string, unknown>`, so nothing in
  // the type system prevents one arriving. Every caller passes zod output today.
  if (value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .map(([key, member]) => [key, stripUndefinedDeep(member)]),
    );
  }
  return value;
}

/**
 * Write-time only, deliberately not a `TtlSchema` refinement: DynamoDB's TTL sweep
 * lags expiry by up to 48 hours, so a schema rule would drop still-present expired
 * rows on read -- including the resume anchor.
 */
function assertTtlNotElapsed(ttl: number): void {
  const nowEpochSeconds = Math.floor(now().valueOf() / 1000);
  if (ttl <= nowEpochSeconds) {
    throw new Error(
      "Refusing to write a lease-cost-history row whose ttl has already elapsed; DynamoDB would reclaim it and the append would report success.",
    );
  }
}

/**
 * A zod issue path as a loggable string. An unrecognized-keys issue is reported
 * at the root, and its offending key names live on `issue.keys`, which is
 * deliberately never logged.
 */
function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(root)" : path.map(String).join(".");
}

export class DynamoLeaseCostHistoryStore extends LeaseCostHistoryStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    client: DynamoDBDocumentClient;
    leaseCostHistoryTableName: string;
  }) {
    super();
    this.tableName = props.leaseCostHistoryTableName;
    this.ddbClient = props.client;
  }

  // COST# and BEDROCK_TOKEN# use a plain Put, so a second write on the same
  // millisecond overwrites. The append is a read-modify-write, and what keeps it
  // safe is the Lease Monitoring Lambda's `reservedConcurrentExecutions: 1` -- see
  // the concurrency warning in the spec before removing that pin or
  // adding a second COST# writer.
  //
  // removeNullFieldsForDynamoDB is deliberately not applied: the schema needs null
  // distinguishable from absent, and this table has no GSI keys to protect.

  public async appendCostObservation(
    row: Omit<CostObservation, "sk" | "meta">,
  ): Promise<CostObservation> {
    assertTtlNotElapsed(row.ttl);
    const key = new LeaseCostHistoryKey(row.leaseUuid);
    const item: CostObservation = CostObservationSchema.parse({
      ...row,
      sk: key.generateCostSk(nowAsIsoDatetimeString()),
      meta: { schemaVersion: LeaseCostHistorySchemaVersion },
    });
    await this.put(item);
    return item;
  }

  public async appendBedrockTokenRow(
    row: Omit<BedrockTokenRow, "sk" | "meta">,
  ): Promise<BedrockTokenRow> {
    assertTtlNotElapsed(row.ttl);
    const key = new LeaseCostHistoryKey(row.leaseUuid);
    const item: BedrockTokenRow = BedrockTokenRowSchema.parse({
      ...row,
      sk: key.generateBedrockTokenSk(nowAsIsoDatetimeString()),
      meta: { schemaVersion: LeaseCostHistorySchemaVersion },
    });
    await this.put(item);
    return item;
  }

  /**
   * Conditional, unlike the other two appends: several writers can record a
   * breach for one lease, and one run can cross several thresholds, so a
   * same-millisecond collision would destroy an audit row. On collision the
   * retry takes a fresh clock reading, advanced past the collided millisecond
   * where the clock has not yet moved, so every key keeps the fixed-width
   * millisecond form the schema pins.
   */
  public async appendBreachRecord(
    row: Omit<BreachRecord, "sk" | "meta">,
  ): Promise<BreachRecord> {
    assertTtlNotElapsed(row.ttl);
    const key = new LeaseCostHistoryKey(row.leaseUuid);
    let observedAt = now();

    for (let attempt = 0; attempt < BREACH_SK_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const fresh = now();
        observedAt =
          fresh.toMillis() > observedAt.toMillis()
            ? fresh
            : observedAt.plus({ milliseconds: 1 });
      }
      const item: BreachRecord = BreachRecordSchema.parse({
        ...row,
        sk: key.generateBreachSk(datetimeAsString(observedAt)),
        meta: { schemaVersion: LeaseCostHistorySchemaVersion },
      });
      try {
        await this.put(item, "attribute_not_exists(sk)");
        return item;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }
      }
    }

    throw new Error(
      `Could not append a breach record: ${BREACH_SK_ATTEMPTS} millisecond sort keys were already taken.`,
    );
  }

  private async put(
    item: Record<string, unknown>,
    conditionExpression?: string,
  ): Promise<void> {
    await this.ddbClient.send(
      new PutCommand({
        TableName: this.tableName,
        // Zod keeps an explicitly-undefined key and the shared document client
        // is built without removeUndefinedValues, which would reject the write.
        Item: stripUndefinedDeep(item) as Record<string, unknown>,
        ConditionExpression: conditionExpression,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Reads. Every read goes through parseRows/parseNewest, which are the only
  // places a zod message exists here -- and it never leaves them.
  // -------------------------------------------------------------------------

  /**
   * One pass yielding the valid rows and the loggable failure shape (paths and
   * codes, never the zod message) together. Not
   * `parseResults`, which exposes only a formatted message -- deriving paths and
   * the drop reason from it would mean parsing every row a second time.
   */
  private parsePage<T extends z.ZodType>(
    items: Record<string, any>[] | undefined,
    schema: T,
  ): {
    rows: z.infer<T>[];
    droppedRecordCount: number;
    droppedRecordReason: DroppedRecordReason;
    invalidPaths: string[];
    issueCodes: string[];
  } {
    const rows: z.infer<T>[] = [];
    const invalidPaths = new Set<string>();
    const issueCodes = new Set<string>();
    let droppedRecordCount = 0;
    let versionOnly = true;

    for (const item of items ?? []) {
      const parsed = schema.safeParse(item);
      if (parsed.success) {
        rows.push(parsed.data);
        continue;
      }
      droppedRecordCount++;
      // Classified from the stored version, not from which issues the parse
      // produced. A newer writer bumps the version AND adds attributes -- that is
      // the only reason to bump it -- so `.strict()` reports `unrecognized_keys` at
      // the root alongside `meta.schemaVersion`, and inferring the reason from the
      // issue set reads a routine rolling deploy as corruption.
      const storedVersion = (item as { meta?: { schemaVersion?: unknown } })
        .meta?.schemaVersion;
      if (
        storedVersion === undefined ||
        LeaseCostHistorySupportedVersionsSchema.safeParse(storedVersion).success
      ) {
        versionOnly = false;
      }
      for (const issue of parsed.error.issues) {
        invalidPaths.add(issuePath(issue.path));
        issueCodes.add(issue.code);
      }
    }

    return {
      rows,
      droppedRecordCount,
      droppedRecordReason:
        droppedRecordCount > 0 && versionOnly
          ? "SCHEMA_VERSION_UNSUPPORTED"
          : "SCHEMA_VALIDATION",
      invalidPaths: [...invalidPaths],
      issueCodes: [...issueCodes],
    };
  }

  /**
   * Issue paths and issue codes, never the zod message -- that message adds the
   * sort-key regex sources, expected types, bounds and `unrecognized_keys`.
   */
  private warnDroppedRows(
    parsed: ReturnType<DynamoLeaseCostHistoryStore["parsePage"]>,
    scope: "the newest row" | "rows",
  ): void {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: dropped ${scope} that failed schema validation`,
      {
        invalidPaths: parsed.invalidPaths,
        issueCodes: parsed.issueCodes,
        droppedRecordReason: parsed.droppedRecordReason,
      },
    );
  }

  private parseRows<T extends z.ZodType>(
    items: Record<string, any>[] | undefined,
    schema: T,
  ): WindowedQueryResult<z.infer<T>> {
    const parsed = this.parsePage(items, schema);
    if (parsed.droppedRecordCount === 0) {
      return { result: parsed.rows };
    }
    this.warnDroppedRows(parsed, "rows");
    return {
      result: parsed.rows,
      droppedRecordCount: parsed.droppedRecordCount,
      droppedRecordReason: parsed.droppedRecordReason,
    };
  }

  private parseNewest<T extends z.ZodType>(
    item: Record<string, any> | undefined,
    schema: T,
  ): NewestRecordResult<z.infer<T>> {
    if (item === undefined) {
      return { complete: true, result: undefined };
    }
    const parsed = this.parsePage([item], schema);
    if (parsed.droppedRecordCount === 0) {
      return { complete: true, result: parsed.rows[0] };
    }
    this.warnDroppedRows(parsed, "the newest row");
    return {
      complete: false,
      droppedRecordCount: 1,
      droppedRecordReason: parsed.droppedRecordReason,
    };
  }

  public async getNewestCostObservation(
    leaseUuid: string,
  ): Promise<NewestRecordResult<CostObservation>> {
    const item = await this.queryNewest(leaseUuid, COST_SK_PREFIX);
    return this.parseNewest(item, CostObservationSchema);
  }

  public async getNewestBedrockTokenRow(
    leaseUuid: string,
  ): Promise<NewestRecordResult<BedrockTokenRow>> {
    const item = await this.queryNewest(leaseUuid, BEDROCK_TOKEN_SK_PREFIX);
    return this.parseNewest(item, BedrockTokenRowSchema);
  }

  public async getNewestBedrockTokenRowAtOrBefore(
    leaseUuid: string,
    timestamp: string,
  ): Promise<NewestRecordResult<BedrockTokenRow>> {
    const item = await this.queryNewest(
      leaseUuid,
      BEDROCK_TOKEN_SK_PREFIX,
      `${BEDROCK_TOKEN_SK_PREFIX}${timestamp}`,
    );
    return this.parseNewest(item, BedrockTokenRowSchema);
  }

  /**
   * Newest row of one record type, at or before `upTo` where given: one
   * query, newest-first, limit 1. The prefix alone sorts before every key it
   * prefixes, so it serves as the lower bound.
   */
  private async queryNewest(
    leaseUuid: string,
    skPrefix: string,
    upTo?: string,
  ): Promise<Record<string, any> | undefined> {
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          upTo === undefined
            ? "#leaseUuid = :leaseUuid AND begins_with(#sk, :skPrefix)"
            : "#leaseUuid = :leaseUuid AND #sk BETWEEN :skPrefix AND :upTo",
        ExpressionAttributeNames: {
          "#leaseUuid": "leaseUuid",
          "#sk": "sk",
        },
        ExpressionAttributeValues: {
          ":leaseUuid": leaseUuid,
          ":skPrefix": skPrefix,
          ...(upTo === undefined ? {} : { ":upTo": upTo }),
        },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    return result.Items?.[0];
  }

  public async getRecentCostObservations(
    leaseUuid: string,
    options: { limit: number },
  ): Promise<RecentCostObservationsResult> {
    assertRowCountInRange("limit", options.limit);
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          "#leaseUuid = :leaseUuid AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: {
          "#leaseUuid": "leaseUuid",
          "#sk": "sk",
        },
        ExpressionAttributeValues: {
          ":leaseUuid": leaseUuid,
          ":skPrefix": COST_SK_PREFIX,
        },
        ScanIndexForward: false,
        Limit: options.limit,
      }),
    );
    // `parsePage` directly, not `parseRows`: this result type requires the reason
    // where `WindowedQueryResult` makes it optional, and forwarding an optional
    // into a required field is what let a hardcoded literal sit here unnoticed.
    // This is the read that gates PREDICTED and RATE enforcement, so reporting a
    // rolling deploy as corruption is the false page the two reasons separate.
    const parsed = this.parsePage(result.Items, CostObservationSchema);
    if (parsed.droppedRecordCount === 0) {
      return { complete: true, result: parsed.rows };
    }
    this.warnDroppedRows(parsed, "rows");
    return {
      complete: false,
      droppedRecordCount: parsed.droppedRecordCount,
      droppedRecordReason: parsed.droppedRecordReason,
    };
  }

  public async listCostObservations(
    leaseUuid: string,
    options: CostHistoryPageOptions,
  ): Promise<PagedQueryResult<CostObservation>> {
    const page = await this.queryPage(leaseUuid, COST_SK_PREFIX, options);
    return {
      ...this.parseRows(page.items, CostObservationSchema),
      nextPageIdentifier: page.nextPageIdentifier,
    };
  }

  /**
   * One page of one row type, newest first, as raw items for the caller to parse.
   * A cursor resumes only the read it came from: the same lease, the same type
   * (the prefix of its sort key) and the same window.
   */
  private async queryPage(
    leaseUuid: string,
    skPrefix: string,
    options: CostHistoryPageOptions,
  ): Promise<{
    items: Record<string, any>[];
    nextPageIdentifier: string | null;
  }> {
    assertRowCountInRange("pageSize", options.pageSize);
    if (options.window !== undefined) {
      assertWindowBounds(options.window);
    }

    let exclusiveStartKey: Record<string, any> | undefined;
    if (options.pageIdentifier !== undefined) {
      let cursor: z.infer<typeof CostHistoryPageIdentifierSchema>;
      try {
        cursor = base64DecodeCompositeKey(options.pageIdentifier, (decoded) =>
          CostHistoryPageIdentifierSchema.parse(decoded),
        );
      } catch {
        // Never expose the caller's cursor or the schema detail in the response.
        throw new InvalidCostHistoryPageIdentifierError();
      }
      const windowMatches =
        cursor.window === null
          ? options.window === undefined
          : cursor.window.from === options.window?.from &&
            cursor.window.to === options.window?.to;
      const cursorTimestamp = cursor.key.sk.slice(skPrefix.length);
      const cursorIsInsideWindow =
        options.window === undefined ||
        (cursorTimestamp >= options.window.from &&
          cursorTimestamp <= options.window.to);
      if (
        cursor.key.leaseUuid !== leaseUuid ||
        !cursor.key.sk.startsWith(skPrefix) ||
        !windowMatches ||
        !cursorIsInsideWindow
      ) {
        throw new InvalidCostHistoryPageIdentifierError();
      }
      exclusiveStartKey = cursor.key;
    }

    // An unbounded read takes every row of the type by prefix; a bounded one
    // narrows to the window. Both bounds or neither, never one: DynamoDB allows a
    // single sort-key condition, so a lone bound would have to be an open-ended
    // comparison, which reaches into the other types' rows on its side. The
    // caller fills the missing side.
    const bounded = options.window !== undefined;
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: bounded
          ? "#leaseUuid = :leaseUuid AND #sk BETWEEN :from AND :to"
          : "#leaseUuid = :leaseUuid AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: {
          "#leaseUuid": "leaseUuid",
          "#sk": "sk",
        },
        ExpressionAttributeValues: {
          ":leaseUuid": leaseUuid,
          ...(options.window === undefined
            ? { ":skPrefix": skPrefix }
            : {
                ":from": `${skPrefix}${options.window.from}`,
                ":to": `${skPrefix}${options.window.to}`,
              }),
        },
        ScanIndexForward: false,
        Limit: options.pageSize,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    const nextPageIdentifier =
      result.LastEvaluatedKey === undefined
        ? null
        : encodeCostHistoryPageIdentifier(
            result.LastEvaluatedKey,
            options.window ?? null,
          );

    return { items: result.Items ?? [], nextPageIdentifier };
  }

  public async listBreachRecords(
    leaseUuid: string,
    options: { from: string; to: string },
  ): Promise<AuditedWindowQueryResult<BreachRecord>> {
    const items = await this.queryWindow(leaseUuid, BREACH_SK_PREFIX, options);
    return this.auditedRows(items, BreachRecordSchema);
  }

  public async listBreachRecordPage(
    leaseUuid: string,
    options: CostHistoryPageOptions,
  ): Promise<PagedQueryResult<BreachRecord>> {
    const page = await this.queryPage(leaseUuid, BREACH_SK_PREFIX, options);
    return {
      ...this.parseRows(page.items, BreachRecordSchema),
      nextPageIdentifier: page.nextPageIdentifier,
    };
  }

  /**
   * Stops once the rows read pass {@link TOKEN_WINDOW_MAX_BYTES}, and resumes
   * below the last row it kept. It stops only after a row a cursor can name, and
   * never before the first row, so every page moves the read on. The rows it
   * leaves are not parsed here: the next page reads them again.
   */
  public async listBedrockTokenRows(
    leaseUuid: string,
    options: CostHistoryPageOptions,
  ): Promise<PagedQueryResult<BedrockTokenRow>> {
    const page = await this.queryPage(
      leaseUuid,
      BEDROCK_TOKEN_SK_PREFIX,
      options,
    );
    const kept: Record<string, any>[] = [];
    let bytes = 0;
    for (const item of page.items) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      const last = kept.at(-1);
      if (
        bytes > TOKEN_WINDOW_MAX_BYTES &&
        last !== undefined &&
        BedrockTokenSkSchema.safeParse(last.sk).success
      ) {
        return {
          ...this.parseRows(kept, BedrockTokenRowSchema),
          nextPageIdentifier: encodeCostHistoryPageIdentifier(
            { leaseUuid, sk: last.sk },
            options.window ?? null,
          ),
        };
      }
      kept.push(item);
    }
    return {
      ...this.parseRows(kept, BedrockTokenRowSchema),
      nextPageIdentifier: page.nextPageIdentifier,
    };
  }

  private auditedRows<T extends z.ZodType>(
    items: Record<string, any>[] | undefined,
    schema: T,
  ): AuditedWindowQueryResult<z.infer<T>> {
    const parsed = this.parseRows(items, schema);
    return {
      result: parsed.result,
      droppedRecordCount: parsed.droppedRecordCount ?? 0,
      droppedRecordReason: parsed.droppedRecordReason ?? null,
    };
  }

  /**
   * Window read bounded with `BETWEEN`, returning raw items for the caller to
   * parse. `LastEvaluatedKey` is drained and there is no row cap: reads are
   * newest-first, so any truncation drops the window's OLDEST rows, which a
   * differencing client reads as a spike on cumulative rows. An over-wide window
   * throws instead. Bounds are checked by {@link assertWindowBounds}.
   */
  private async queryWindow(
    leaseUuid: string,
    skPrefix: string,
    options: { from: string; to: string },
  ): Promise<Record<string, any>[]> {
    const items: Record<string, any>[] = [];
    let bytes = 0;
    for await (const page of this.windowPages(leaseUuid, skPrefix, options)) {
      items.push(...page);
      // Per page: the page cap alone admits 20 full 1 MB pages before it fires.
      bytes += Buffer.byteLength(JSON.stringify(page));
      if (bytes > WINDOW_QUERY_MAX_BYTES) {
        throw new Error(
          `Window query exceeded ${WINDOW_QUERY_MAX_BYTES} bytes; narrow the window.`,
        );
      }
    }
    return items;
  }

  /**
   * One window's `BETWEEN` query, page by page, newest first, draining
   * `LastEvaluatedKey` up to {@link WINDOW_QUERY_MAX_PAGES} and throwing past it.
   */
  private async *windowPages(
    leaseUuid: string,
    skPrefix: string,
    options: { from: string; to: string },
  ): AsyncGenerator<Record<string, any>[]> {
    assertWindowBounds(options);

    const paginator = paginateQuery(
      { client: this.ddbClient },
      {
        TableName: this.tableName,
        KeyConditionExpression:
          "#leaseUuid = :leaseUuid AND #sk BETWEEN :from AND :to",
        ExpressionAttributeNames: {
          "#leaseUuid": "leaseUuid",
          "#sk": "sk",
        },
        ExpressionAttributeValues: {
          ":leaseUuid": leaseUuid,
          ":from": `${skPrefix}${options.from}`,
          ":to": `${skPrefix}${options.to}`,
        },
        ScanIndexForward: false,
      },
    );
    let pages = 0;
    for await (const page of paginator) {
      yield page.Items ?? [];
      if (
        ++pages >= WINDOW_QUERY_MAX_PAGES &&
        page.LastEvaluatedKey !== undefined
      ) {
        throw new Error(
          `Window query exceeded ${WINDOW_QUERY_MAX_PAGES} pages; narrow the window.`,
        );
      }
    }
  }
}
