// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/** Sandbox Spaces token pricing, usage recording, and display reads. */
import {
  MalformedSandboxSpacesUsageRecordError,
  roundSpend,
  SandboxSpacesTokenUsage,
} from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import {
  LeaseSandboxSpacesUsageBreakdown,
  ModelTokenRates,
  RecordSandboxSpacesTurnUsageProps,
  SandboxSpacesUsageServices,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-spaces-usage/sandbox-spaces-usage.types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  isAdminOrManager,
  isIdcUser,
  type IsbUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

/** Prices the four token types to USD, rounded for banking. Unpublished cache rates fall back to the input rate. */
export function priceTurn(
  tokens: SandboxSpacesTokenUsage,
  rates: ModelTokenRates,
): number {
  const { inputPricePer1KTokens: input, outputPricePer1KTokens: output } =
    rates;
  const cacheRead = rates.cacheReadPricePer1KTokens ?? input;
  const cacheWrite = rates.cacheWritePricePer1KTokens ?? input;
  return roundSpend(
    (tokens.inputTokens * input +
      tokens.outputTokens * output +
      tokens.cacheReadTokens * cacheRead +
      tokens.cacheWriteTokens * cacheWrite) /
      1000,
  );
}

/** Sum of the four metered token types. */
export function sumTokenTypes(tokens: SandboxSpacesTokenUsage): number {
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheReadTokens +
    tokens.cacheWriteTokens
  );
}

/**
 * The caller's estimated Sandbox Spaces token cost on the lease, for display.
 * An unreadable row yields undefined so display callers can omit it.
 */
export async function getCallerSandboxSpacesEstimatedTokenCost(
  props: { leaseId: string; userId: string },
  services: SandboxSpacesUsageServices,
): Promise<number | undefined> {
  const { sandboxSpacesUsageStore, logger } = services;
  try {
    const row = await sandboxSpacesUsageStore.getLeaseUserUsage(
      props.leaseId,
      props.userId,
    );
    return row?.sandboxSpacesEstimatedTokenCostAccrued ?? 0;
  } catch (error) {
    if (error instanceof MalformedSandboxSpacesUsageRecordError) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: caller Sandbox Spaces usage record unreadable — omitting it`,
        { leaseId: props.leaseId, error },
      );
      return undefined;
    }
    throw error;
  }
}

/**
 * A lease's total estimated Sandbox Spaces token cost, summed across its
 * per-user records, for reporting. Undefined when any record is unreadable, so
 * a partial sum is never reported as the lease total. Infrastructure errors
 * are rethrown.
 */
export async function getLeaseSandboxSpacesEstimatedTokenCost(
  props: { leaseId: string },
  services: SandboxSpacesUsageServices,
): Promise<number | undefined> {
  const { leaseId } = props;
  const { sandboxSpacesUsageStore, logger } = services;
  const users = await sandboxSpacesUsageStore.listLeaseUserUsage(leaseId);
  if (users.error !== undefined) {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: Sandbox Spaces usage records unreadable — omitting the lease total`,
      { leaseId, error: users.error },
    );
    return undefined;
  }
  return roundSpend(
    users.usage.reduce(
      (total, row) => total + row.sandboxSpacesEstimatedTokenCostAccrued,
      0,
    ),
  );
}

/**
 * A lease's estimated Sandbox Spaces token cost split by user. Admins and
 * Managers see every user, highest cost first; everyone else sees only their
 * own entry. A per-user record that cannot be read is left out and logged, for
 * every role, rather than failing the read. The caller must already be
 * authorized to read the lease.
 */
export async function getLeaseSandboxSpacesUsageBreakdown(
  props: { leaseId: string; user: IsbUser },
  services: SandboxSpacesUsageServices,
): Promise<LeaseSandboxSpacesUsageBreakdown> {
  const { leaseId, user } = props;
  const { sandboxSpacesUsageStore, logger } = services;

  if (isAdminOrManager(user)) {
    const users = await sandboxSpacesUsageStore.listLeaseUserUsage(leaseId);
    if (users.error !== undefined) {
      logger.warn("Some per-user Sandbox Spaces usage records were skipped", {
        leaseId,
        error: users.error,
      });
    }
    const spendByUsers = users.usage
      .map((row) => ({
        userId: row.userId,
        sandboxSpacesEstimatedTokenCostAccrued:
          row.sandboxSpacesEstimatedTokenCostAccrued,
      }))
      .sort(
        (a, b) =>
          b.sandboxSpacesEstimatedTokenCostAccrued -
            a.sandboxSpacesEstimatedTokenCostAccrued ||
          a.userId.localeCompare(b.userId),
      );
    return { spendByUsers };
  }

  // Machine identities have no Identity Center id, so they have no rows of their own.
  const userId = isIdcUser(user) ? user.userId : undefined;
  const own =
    userId === undefined
      ? undefined
      : await getCallerSandboxSpacesEstimatedTokenCost(
          { leaseId, userId },
          services,
        );
  return {
    spendByUsers:
      userId !== undefined && own !== undefined
        ? [{ userId, sandboxSpacesEstimatedTokenCostAccrued: own }]
        : [],
  };
}

/** Banks one already-priced turn in the lease's Sandbox Spaces usage. */
export async function recordSandboxSpacesTurnUsage(
  props: RecordSandboxSpacesTurnUsageProps,
  services: SandboxSpacesUsageServices,
): Promise<void> {
  const {
    leaseId,
    userId,
    userEmail,
    messageId,
    month,
    modelId,
    tokens,
    sandboxSpacesEstimatedTokenCostAccrued,
    sessionId,
  } = props;
  const { sandboxSpacesUsageStore, logger } = services;

  await sandboxSpacesUsageStore.recordTurnUsage({
    leaseId,
    userId,
    userEmail,
    month,
    tokens,
    sandboxSpacesEstimatedTokenCostAccrued,
    sessionId,
  });
  logger.debug("Recorded Sandbox Spaces turn usage", {
    leaseId,
    messageId,
    modelId,
    sandboxSpacesEstimatedTokenCostAccrued,
  });
}
