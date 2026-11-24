// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { createHash } from "node:crypto";
import { z } from "zod";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  getAssignablePermissionSets,
  loadPermissionSetContext,
} from "@amzn/innovation-sandbox-commons/isb-services/permission-set/index.js";
import { PermissionSetsLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/permission-sets-lambda-environment.js";
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { PermissionSetIdSchema } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

import type {
  ListPermissionSetsServerInput,
  ListPermissionSetsServerOutput,
  PermissionSetsApiService,
} from "@amzn/innovation-sandbox-api-server/permission-sets";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/permission-sets";

export type PermissionSetsSmithyContext =
  IsbSmithyContext<PermissionSetsLambdaEnvironment>;

const DEFAULT_MAX_RESULTS = 50;
const NEXT_PAGE_IDENTIFIER_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const NextPageIdentifierSchema = z
  .object({
    version: z.literal(NEXT_PAGE_IDENTIFIER_VERSION),
    queryHash: z.string().regex(SHA256_PATTERN),
    catalogHash: z.string().regex(SHA256_PATTERN),
    normalizedName: z.string().min(1).max(32),
    permissionSetId: PermissionSetIdSchema,
  })
  .strict();

type NextPageIdentifier = z.infer<typeof NextPageIdentifierSchema>;

type SortKey = Pick<NextPageIdentifier, "normalizedName" | "permissionSetId">;

const normalize = (value: string): string =>
  value.normalize("NFKC").toLowerCase();

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const compareSortKeys = (left: SortKey, right: SortKey): number => {
  if (left.normalizedName < right.normalizedName) {
    return -1;
  }
  if (left.normalizedName > right.normalizedName) {
    return 1;
  }
  if (left.permissionSetId < right.permissionSetId) {
    return -1;
  }
  if (left.permissionSetId > right.permissionSetId) {
    return 1;
  }
  return 0;
};

const catalogHash = (entries: SortKey[]): string => {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.normalizedName, "utf8");
    hash.update("\0");
    hash.update(entry.permissionSetId, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
};

function encodeNextPageIdentifier({
  hasNextPage,
  last,
  queryHash,
  catalogHash,
}: {
  hasNextPage: boolean;
  last: SortKey | undefined;
  queryHash: string;
  catalogHash: string;
}): string | undefined {
  if (!hasNextPage || last === undefined) {
    return undefined;
  }

  return Buffer.from(
    JSON.stringify({
      version: NEXT_PAGE_IDENTIFIER_VERSION,
      queryHash,
      catalogHash,
      normalizedName: last.normalizedName,
      permissionSetId: last.permissionSetId,
    }),
    "utf8",
  ).toString("base64url");
}

function createInvalidNextPageIdentifierError() {
  return createHttpJSendError({
    statusCode: 400,
    errorType: "ValidationError",
    data: {
      errors: [
        {
          field: "pageIdentifier",
          message: "The pagination token is invalid for this request.",
        },
      ],
    },
  });
}

function decodeNextPageIdentifier(
  pageIdentifier: string | undefined,
  queryHash: string,
): NextPageIdentifier | undefined {
  if (pageIdentifier === undefined) {
    return undefined;
  }

  try {
    const json = Buffer.from(pageIdentifier, "base64url").toString("utf8");
    const decodedNextPageIdentifier = NextPageIdentifierSchema.parse(
      JSON.parse(json),
    );
    if (
      decodedNextPageIdentifier.queryHash !== queryHash ||
      encodeNextPageIdentifier({
        hasNextPage: true,
        last: decodedNextPageIdentifier,
        queryHash: decodedNextPageIdentifier.queryHash,
        catalogHash: decodedNextPageIdentifier.catalogHash,
      }) !== pageIdentifier
    ) {
      throw createInvalidNextPageIdentifierError();
    }
    return decodedNextPageIdentifier;
  } catch {
    throw createInvalidNextPageIdentifierError();
  }
}

function listPermissionSets(logger: Logger) {
  return async (
    input: ListPermissionSetsServerInput,
    context: PermissionSetsSmithyContext,
  ): Promise<ListPermissionSetsServerOutput> => {
    const { env } = context.lambdaContext;
    const query = normalize(input.q?.trim() ?? "");
    const queryHash = sha256(query);
    const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
    const decodedNextPageIdentifier = decodeNextPageIdentifier(
      input.pageIdentifier,
      queryHash,
    );

    const permissionSetContext = await loadPermissionSetContext(
      IsbServices.idcStackConfigStore(env),
      IsbServices.principalStore(env),
    );
    const assignablePermissionSets =
      getAssignablePermissionSets(permissionSetContext);

    const matches = assignablePermissionSets
      .filter((item) => {
        if (query.length === 0) {
          return true;
        }
        return (
          normalize(item.name).includes(query) ||
          normalize(item.description ?? "").includes(query)
        );
      })
      .map((item) => ({
        item,
        normalizedName: normalize(item.name),
        permissionSetId: item.permissionSetId,
      }))
      .sort(compareSortKeys);

    const currentCatalogHash = catalogHash(matches);
    if (
      decodedNextPageIdentifier !== undefined &&
      decodedNextPageIdentifier.catalogHash !== currentCatalogHash
    ) {
      throw createInvalidNextPageIdentifierError();
    }

    const firstIndex =
      decodedNextPageIdentifier === undefined
        ? 0
        : matches.findIndex(
            (entry) => compareSortKeys(entry, decodedNextPageIdentifier) > 0,
          );
    const pageStart = firstIndex < 0 ? matches.length : firstIndex;
    const page = matches.slice(pageStart, pageStart + maxResults);
    const hasNextPage = pageStart + page.length < matches.length;
    const last = page.at(-1);

    logger.info("Permission sets listed", {
      queryLength: query.length,
      totalCached: permissionSetContext.cacheByArn.size,
      totalMatches: matches.length,
      returned: page.length,
      hasNextPage,
    });

    return {
      status: JSendStatus.SUCCESS,
      data: {
        result: page.map(({ item }) => item),
        nextPageIdentifier: encodeNextPageIdentifier({
          hasNextPage,
          last,
          queryHash,
          catalogHash: currentCatalogHash,
        }),
      },
    };
  };
}

export function permissionSetsService(
  logger: Logger,
): PermissionSetsApiService<PermissionSetsSmithyContext> {
  return {
    ListPermissionSets: withDelegatedErrors(listPermissionSets(logger)),
  };
}
