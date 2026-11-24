// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { PrincipalsLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { groupAssignmentsEnabled } from "@amzn/innovation-sandbox-shared/utils/group-assignment-policy.js";

import type {
  PrincipalsApiService,
  SearchPrincipalsServerInput,
  SearchPrincipalsServerOutput,
} from "@amzn/innovation-sandbox-api-server/principals";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/principals";

export type PrincipalsSmithyContext =
  IsbSmithyContext<PrincipalsLambdaEnvironment>;

// Pre-Smithy query defaults. The model leaves the params optional (so an absent
// value is not a validation error), and the operation applies these — matching
// the pre-Smithy `SearchQueryParametersSchema.default(...)`.
const DEFAULT_LIMIT = 20;

// Public `type` filter → the store's principal-type filter (`undefined` = both).
const TYPE_PARAM_TO_FILTER = {
  users: "USER",
  groups: "GROUP",
  all: undefined,
} as const;

type SearchTypeParam = keyof typeof TYPE_PARAM_TO_FILTER;

/** `GET /principals/search` — fuzzy cache search or exact IDC lookup. */
function searchPrincipals(logger: Logger) {
  return async (
    input: SearchPrincipalsServerInput,
    context: PrincipalsSmithyContext,
  ): Promise<SearchPrincipalsServerOutput> => {
    const { env, globalConfig } = context.lambdaContext;

    const query = input.q ?? "";
    const typeParam: SearchTypeParam = input.type ?? "all";
    const limit = input.limit ?? DEFAULT_LIMIT;
    const exact = input.exact ?? false;

    // Gate: when principal search is disabled, only exact lookups are allowed.
    if (!globalConfig.leases.enablePrincipalSearch && !exact) {
      throw createHttpJSendError({
        statusCode: 403,
        data: { errors: [{ message: "Principal search is not enabled." }] },
      });
    }

    const groupSearchEnabled = groupAssignmentsEnabled(
      globalConfig.leases.groupAssignmentMode,
    );
    if (!groupSearchEnabled && typeParam === "groups") {
      throw createHttpJSendError({
        statusCode: 403,
        data: { errors: [{ message: "Group search is not enabled." }] },
      });
    }

    if (exact) {
      return handleExactLookup(query, typeParam, context, logger);
    }

    // Fuzzy and exact cache hits reflect the hourly membership snapshot.
    // Exact cache misses use membership-aware IDC read-through.
    const principalStore = IsbServices.principalStore(env);
    const cacheItems = await principalStore.getCacheItems({
      type: groupSearchEnabled ? TYPE_PARAM_TO_FILTER[typeParam] : "USER",
    });

    const lower = query.toLowerCase();
    const matched = cacheItems.filter(
      (item) =>
        query.length === 0 ||
        (item.displayName?.toLowerCase().includes(lower) ?? false) ||
        (item.email?.toLowerCase().includes(lower) ?? false),
    );

    const principals = matched.slice(0, limit).map((item) => ({
      principalId: item.principalId,
      principalType: item.principalType,
      displayName: item.displayName,
      email: item.email,
    }));

    // Log the query length, not the query itself: a fuzzy term (and especially an
    // exact-lookup email) is PII, and the response `email` is already `@sensitive`.
    logger.info("Principals search complete", {
      queryLength: query.length,
      type: typeParam,
      limit,
      totalMatches: matched.length,
      returned: principals.length,
    });

    return {
      status: JSendStatus.SUCCESS,
      data: { principals, totalMatches: matched.length },
    };
  };
}

/** Exact principal resolution through the membership-aware read-through cache. */
async function handleExactLookup(
  query: string,
  typeParam: SearchTypeParam,
  context: PrincipalsSmithyContext,
  logger: Logger,
): Promise<SearchPrincipalsServerOutput> {
  if (query.length === 0) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          { message: "Query parameter 'q' is required for exact lookups." },
        ],
      },
    });
  }
  if (typeParam === "all") {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            message:
              "Query parameter 'type' must be 'users' or 'groups' for exact lookups.",
          },
        ],
      },
    });
  }

  const { env } = context.lambdaContext;
  // `typeParam` is narrowed to "users" | "groups" above, so the lookup is
  // "USER" | "GROUP" (never the `all` → undefined entry) — no non-null assertion.
  const idcType = TYPE_PARAM_TO_FILTER[typeParam];
  const credentials = fromTemporaryIsbIdcCredentials(env);
  const idcService = IsbServices.idcService(env, credentials);
  const principalStore = IsbServices.principalStore(env);

  const resolved = await idcService.getCachedPrincipalByAttr(
    idcType,
    query,
    principalStore,
    logger,
  );

  if (!resolved) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [{ message: "Principal not found in the identity store." }],
      },
    });
  }

  // The exact-lookup query is routinely the email being resolved — log its length
  // and the resolved id, never the raw address.
  logger.info("Exact lookup resolved", {
    queryLength: query.length,
    type: typeParam,
    principalId: resolved.principalId,
  });

  return {
    status: JSendStatus.SUCCESS,
    data: {
      principals: [
        {
          principalId: resolved.principalId,
          principalType: resolved.principalType,
          displayName: resolved.displayName,
          email: resolved.email,
        },
      ],
      totalMatches: 1,
    },
  };
}

/**
 * The `PrincipalsApi` service — the single `SearchPrincipals` operation. Wrapped
 * in `withDelegatedErrors` so the gate 403, exact-lookup 400s, and 404 render
 * through the shared Middy `httpErrorHandler` exactly as the pre-Smithy handler.
 */
export function principalsService(
  logger: Logger,
): PrincipalsApiService<PrincipalsSmithyContext> {
  return {
    SearchPrincipals: withDelegatedErrors(searchPrincipals(logger)),
  };
}
