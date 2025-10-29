// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  PaginatedQueryResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  ItemWithMetadata,
  withUpdatedMetadata,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { z } from "zod";

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
 * returns a decorator that validates the item against the provided schema
 * The schema should include version validation in its metadata field
 * @param schema zod schema for data validation (including version validation)
 */
export function validateItem<U extends z.ZodSchema<any>>(schema: U) {
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

export function parseResults<T extends z.ZodSchema>(
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
  const parsed = items.map((item) => schema.safeParse(item));
  const validItems: T[] = parsed
    .filter((parsedItem) => parsedItem.success)
    .map((parsedItem) => parsedItem.data);
  const errors: z.ZodError<T>[] = parsed
    .filter((parsedItem) => !parsedItem.success)
    .map((parsedItem) => parsedItem.error);
  const errorMessage = errors.length == 0 ? undefined : formatErrors(errors);

  return {
    result: validItems,
    error: errorMessage,
  };
}

export function parseSingleItemResult<T extends z.ZodSchema>(
  item: Record<string, any> | undefined,
  schema: T,
): SingleItemResult<z.infer<T>> {
  if (!item) {
    return {
      result: undefined,
    };
  }
  const parsedItem = schema.safeParse(item);
  if (!parsedItem.success) {
    return {
      result: undefined,
      error: `Invalid record found: ${parsedItem.error.message}`,
    };
  } else {
    return {
      result: parsedItem.data,
    };
  }
}
