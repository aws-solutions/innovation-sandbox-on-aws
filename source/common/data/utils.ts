// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  BatchWriteCommandInput,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { backOff } from "exponential-backoff";
import { isDeepStrictEqual } from "node:util";
import pMap from "p-map";
import { z } from "zod";

import {
  PaginatedQueryResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { BatchUnprocessedItemsError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  ItemWithMetadata,
  withUpdatedMetadata,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";

export async function* stream<Args extends { pageIdentifier?: string }, T>(
  thisRef: object,
  paginatedQueryFunc: (args: Args) => Promise<PaginatedQueryResult<T>>,
  args: Args,
): AsyncGenerator<T> {
  paginatedQueryFunc = paginatedQueryFunc.bind(thisRef);
  let queryResult: PaginatedQueryResult<T>;
  do {
    queryResult = await paginatedQueryFunc(args);

    for (const item of queryResult.result) {
      yield item;
    }
    //setup next loop
    args.pageIdentifier = replaceNullWithUndefined(
      queryResult.nextPageIdentifier,
    );
  } while (queryResult.nextPageIdentifier);
}

export async function collect<T>(
  generator: AsyncGenerator<T>,
  opt?: {
    maxCount?: number;
  },
) {
  const collectedItems: T[] = [];
  for await (const value of generator) {
    collectedItems.push(value);
    if (opt?.maxCount && collectedItems.length >= opt.maxCount) {
      break;
    }
  }
  return collectedItems;
}

function replaceNullWithUndefined<T>(val: T) {
  if (val === null) {
    return undefined;
  }
  return val;
}

/**
 * Removes null fields from an object for DynamoDB sparse GSI compatibility.
 * DynamoDB GSI keys cannot be NULL - they must either have a value or not exist.
 *
 * @param item - Object to transform
 * @returns New object with null fields removed
 */
export function removeNullFieldsForDynamoDB<T extends Record<string, any>>(
  item: T,
): T {
  const transformed = { ...item };
  Object.keys(transformed).forEach((key) => {
    if (transformed[key] === null) {
      delete transformed[key];
    }
  });
  return transformed;
}

/**
 * Compare top-level stored fields using aliases for attribute names.
 * Undefined requires absence; null requires a stored NULL unless the field
 * explicitly opts into treating null and absence as equivalent.
 */
export function buildExpectedFieldsCondition(
  expected: Record<string, unknown>,
  options: { nullMatchesMissing?: readonly string[] } = {},
): {
  conditionExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, unknown>;
} {
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};
  const conditions = Object.entries(expected).map(([field, value]) => {
    const name = `#expected_${field}`;
    const placeholder = `:expected_${field}`;
    expressionAttributeNames[name] = field;
    if (value === undefined) {
      return `attribute_not_exists(${name})`;
    }
    expressionAttributeValues[placeholder] = value;
    return value === null && options.nullMatchesMissing?.includes(field)
      ? `(attribute_not_exists(${name}) OR ${name} = ${placeholder})`
      : `${name} = ${placeholder}`;
  });
  return {
    conditionExpression: conditions.join(" AND "),
    expressionAttributeNames,
    expressionAttributeValues,
  };
}

/**
 * Compare a DynamoDB item image with native expected fields. Undefined requires
 * absence. Exact comparison also rejects stored fields outside the expected set.
 */
export function matchesExpectedFields(
  storedFields: Record<string, AttributeValue> | undefined,
  expected: Record<string, unknown>,
  options: { exact?: boolean } = {},
): boolean {
  if (!storedFields) {
    return false;
  }
  const expectedFields = marshall(expected, { removeUndefinedValues: true });
  if (
    options.exact &&
    Object.keys(storedFields).length !== Object.keys(expectedFields).length
  ) {
    return false;
  }
  return Object.keys(expected).every((field) =>
    isDeepStrictEqual(expectedFields[field], storedFields[field]),
  );
}

/**
 * returns a decorator that validates the item against the provided schema
 * The schema should include version validation in its metadata field
 * @param schema zod schema for data validation (including version validation)
 */
export function validateItem<U extends z.ZodType<any>>(schema: U) {
  return function <
    T extends ItemWithMetadata,
    OtherParams extends any[],
    ReturnType,
  >(
    value: (param: T, ...otherParams: OtherParams) => ReturnType,
    _context: ClassMethodDecoratorContext,
  ) {
    return function (
      this: any,
      param: T,
      ...otherParams: OtherParams
    ): ReturnType {
      schema.parse(param);
      return value.call(this, param, ...otherParams);
    };
  };
}

/**
 * returns a decorator that enhances the item with metadata
 * @param schemaVersion
 */
export function withMetadata(schemaVersion: number) {
  return function <
    T extends ItemWithMetadata,
    OtherParams extends any[],
    ReturnType,
  >(
    value: (param: T, ...otherParams: OtherParams) => ReturnType,
    _context: ClassMethodDecoratorContext,
  ) {
    return function (
      this: any,
      param: T,
      ...otherParams: OtherParams
    ): ReturnType {
      const updatedMetadata = withUpdatedMetadata(param, schemaVersion);
      return value.call(this, updatedMetadata, ...otherParams);
    };
  };
}

function formatErrors(errors: z.ZodError[]) {
  const errorCount = errors.length;
  const errorMessages = errors.map((error) => "\n  " + error.message).join("");
  return `${errorCount} invalid records found: ${errorMessages}`;
}

export function parseResults<T extends z.ZodType>(
  items: Record<string, any>[] | undefined,
  schema: T,
): {
  result: z.infer<T>[];
  error?: string;
} {
  if (!items) {
    return {
      result: [],
    };
  }
  const validItems: z.infer<T>[] = [];
  const errors: z.ZodError[] = [];
  for (const item of items) {
    const parsedItem = schema.safeParse(item);
    if (parsedItem.success) {
      validItems.push(parsedItem.data);
    } else {
      errors.push(parsedItem.error);
    }
  }
  const errorMessage = errors.length == 0 ? undefined : formatErrors(errors);

  return {
    result: validItems,
    error: errorMessage,
  };
}

export function parseSingleItemResult<T extends z.ZodType>(
  item: Record<string, any> | undefined,
  schema: T,
): SingleItemResult<z.infer<T>> {
  if (!item) {
    return {
      result: undefined,
    };
  }
  const parsedItem = schema.safeParse(item);
  if (parsedItem.success) {
    return {
      result: parsedItem.data,
    };
  } else {
    return {
      result: undefined,
      error: `Invalid record found: ${parsedItem.error.message}`,
    };
  }
}

/** Splits an array into chunks of the specified size. */
export function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
}

type WriteRequest = NonNullable<
  BatchWriteCommandInput["RequestItems"]
>[string][number];

export interface BatchWriteWithRetryProps {
  client: DynamoDBDocumentClient;
  tableName: string;
  batches: WriteRequest[][];
  concurrency?: number;
  numOfAttempts?: number;
  startingDelay?: number;
}

/**
 * Executes DynamoDB batch writes concurrently, retrying only the unprocessed
 * requests returned by each call.
 */
export async function batchWriteWithRetry({
  client,
  tableName,
  batches,
  concurrency = 2,
  numOfAttempts = 5,
  startingDelay = 1000,
}: BatchWriteWithRetryProps): Promise<void> {
  await pMap(
    batches,
    async (batch) => {
      let requestItems: BatchWriteCommandInput["RequestItems"] = {
        [tableName]: batch,
      };

      await backOff(
        async () => {
          const result = await client.send(
            new BatchWriteCommand({ RequestItems: requestItems }),
          );
          const unprocessed = result.UnprocessedItems?.[tableName];
          if (unprocessed && unprocessed.length > 0) {
            requestItems = { [tableName]: unprocessed };
            throw new BatchUnprocessedItemsError(unprocessed.length);
          }
        },
        {
          numOfAttempts,
          startingDelay,
          jitter: "full",
          retry: (error: unknown) =>
            error instanceof BatchUnprocessedItemsError,
        },
      );
    },
    { concurrency },
  );
}
