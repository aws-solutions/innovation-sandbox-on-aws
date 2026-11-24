// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { z } from "zod";

import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  ConcurrentDataModificationException,
  ResourceLockConflictError,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  validateBudgetThresholdsBelowMaxSpend,
  validateLeaseCompliesWithGlobalConfig,
  validatePredictiveBudgetFields,
  validateSandboxSpacesFields,
  ValidationException,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { type GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import {
  CostHistoryPageIdentifierSchema,
  InvalidCostHistoryPageIdentifierError,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import { IsoMillisSchema } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import { PersistedLeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  type PersistedMonitoredLease,
  PersistedLease,
  PersistedLeaseSchema,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { validateCostReportGroup } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config-utils.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import {
  AccountNotInActiveError,
  AccountNotInFrozenError,
  CouldNotFindAccountError,
  CouldNotRetrieveUserError,
  InnovationSandbox,
  IsbContext,
  LeaseRequestRateLimitExceededError,
  MaxNumberOfLeasesExceededError,
  NoAccountsAvailableError,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import {
  assertSandboxSpacesModelSelection,
  leaseModelAccess,
  selectableModelsForLeaseAccess,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/index.js";
import {
  type CostHistoryServices,
  type LeaseHistoryPageRequest,
  buildBedrockTokenHistoryData,
  buildBreachHistoryData,
  buildCostHistoryData,
  buildCostSummaryData,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-history/index.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  deriveAssignmentProjection,
  getLeasesForUserDirect,
  getLeasesForUserViaGroups,
  IneligibleAssignmentPrincipalError,
  IneligibleLeaseOwnerError,
  InvalidDirectLeasePageIdentifierError,
  MaxAssignmentsExceededError,
  normalizeAssignmentsWithOwner,
  triggerAssignmentProcessing,
} from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import {
  type PermissionSetContext,
  type ResolvedPermissionSetConfig,
  hydratePermissionSetReference,
  hydratePermissionSets,
  isSystemPermissionSetArn,
  loadPermissionSetContext,
  resolvePermissionSetConfig,
  validateNewAssignmentGrants,
} from "@amzn/innovation-sandbox-commons/isb-services/permission-set/index.js";
import { LeaseLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
  throwValidationErrorAs400,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { rejectIfAssigneeIsM2m } from "@amzn/innovation-sandbox-commons/lambda/middleware/m2m-guard.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { parseRawJsonBody } from "@amzn/innovation-sandbox-commons/lambda/smithy/parse-raw-json-body.js";
import {
  LogPatterns,
  logTaggingFailure,
  summarizeUpdate,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { NO_COST_REPORT_GROUP_TAG_VALUE } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";
import {
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import type { AgentConfig } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import type {
  BedrockTokenHistoryData,
  BreachEntry,
  BreachHistoryData,
  BreachInsight,
  CostHistoryCurrent,
  CostHistoryData,
  CostHistoryResultRow,
  CostSummaryData,
  CurrentServiceEntry,
  TokenSeriesRow,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import {
  type DesiredAssignment,
  DesiredAssignmentSchema,
  isActiveLease,
  isFrozenLease,
  isMonitoredLease,
  isPendingLease,
  LEASE_NOT_PENDING_REVIEW_ERROR,
  LeaseKeySchema,
  MAX_ASSIGNMENTS,
  MonitoredLeaseStatusSchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  IdcPrincipalIdSchema,
  PrincipalTypeSchema,
} from "@amzn/innovation-sandbox-shared/types/principal.js";
import {
  type IsbUser,
  getUserEmail,
  isAdminOrManager,
  isIdcUser,
  isM2MUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { findDisallowedGroupAssignments } from "@amzn/innovation-sandbox-shared/utils/group-assignment-policy.js";
import { isLeaseOwnerOrDirectAssignee } from "@amzn/innovation-sandbox-shared/utils/lease-access.js";

import type {
  FreezeLeaseServerInput,
  FreezeLeaseServerOutput,
  GetLeaseAssignmentsServerInput,
  GetLeaseAssignmentsServerOutput,
  GetLeaseBedrockTokenHistoryServerInput,
  GetLeaseBedrockTokenHistoryServerOutput,
  GetLeaseBreachHistoryServerInput,
  GetLeaseBreachHistoryServerOutput,
  GetLeaseCostHistoryServerInput,
  GetLeaseCostHistoryServerOutput,
  GetLeaseCostSummaryServerInput,
  GetLeaseCostSummaryServerOutput,
  GetLeaseServerInput,
  GetLeaseServerOutput,
  LeasesApiService,
  ListLeasesServerInput,
  ListLeasesServerOutput,
  ListSharedLeasesServerInput,
  ListSharedLeasesServerOutput,
  RequestLeaseServerInput,
  RequestLeaseServerOutput,
  ReviewLeaseServerInput,
  ReviewLeaseServerOutput,
  BreachEntry as SmithyBreachEntry,
  BreachInsight as SmithyBreachInsight,
  CostHistoryCurrent as SmithyCostHistoryCurrent,
  CostHistoryResultRow as SmithyCostHistoryResultRow,
  CurrentServiceEntry as SmithyCurrentServiceEntry,
  TokenSeriesRow as SmithyTokenSeriesRow,
  TerminateLeaseServerInput,
  TerminateLeaseServerOutput,
  UnfreezeLeaseServerInput,
  UnfreezeLeaseServerOutput,
  UpdateLeaseAssignmentsServerInput,
  UpdateLeaseAssignmentsServerOutput,
  UpdateLeaseServerInput,
  UpdateLeaseServerOutput,
} from "@amzn/innovation-sandbox-api-server/leases";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/leases";

export type LeasesSmithyContext = IsbSmithyContext<LeaseLambdaEnvironment>;

type LeaseLambdaContext = LeasesSmithyContext["lambdaContext"];

const tracer = new Tracer();

// Pre-Smithy pagination defaults (the pre-Smithy query schemas applied `maxResults`
// defaults). The model validates the range (`@range(min:1,max:2000)` /
// `@range(min:1,max:100)`); the operation applies the default when `maxResults` is
// absent — defaults are operation behavior, not model traits, so they stay here
// (mirroring the Accounts operations' `LIST_*_DEFAULT_MAX` consts).
const LIST_LEASES_DEFAULT_MAX = 2000;
const LIST_SHARED_LEASES_DEFAULT_MAX = 100;
const COST_HISTORY_DEFAULT_MAX = 100;

// Module-scoped so the "lease request window capped" warning is logged at most
// once per Lambda container, exactly as the pre-Smithy handler did.
let leaseRequestWindowCappedLogged = false;

// ---------------------------------------------------------------------------
// Shared response / context / fetch helpers
// ---------------------------------------------------------------------------

/**
 * Build a JSend HTTP error carrying a single `errors[].message` — the shape every
 * lease operation returns. `extraData` merges extra top-level `data` members (the
 * 429's `retryAt`). Returns the error; callers `throw` it (a couple capture it
 * first, e.g. the terminate 403).
 */
function jsendError(
  statusCode: number,
  message: string,
  extraData?: Record<string, unknown>,
) {
  return createHttpJSendError({
    statusCode,
    data: { errors: [{ message }], ...extraData },
  });
}

/**
 * The IsbServices + cross-account-credentials bundle shared by the write and
 * lifecycle operations. Each caller spreads it and adds its own extras — the
 * event-bridge member name differs (`eventBridgeClient` vs `isbEventBridgeClient`)
 * and some add blueprint / global-config / template members.
 */
function baseLeaseIsbContext(env: LeaseLambdaContext["env"], logger: Logger) {
  return {
    logger,
    tracer,
    leaseStore: IsbServices.leaseStore(env),
    sandboxAccountStore: IsbServices.sandboxAccountStore(env),
    idcService: IsbServices.idcService(
      env,
      fromTemporaryIsbIdcCredentials(env),
    ),
    orgsService: IsbServices.orgsService(
      env,
      fromTemporaryIsbOrgManagementCredentials(env),
    ),
    organizationsTaggingService: IsbServices.organizationsTaggingService(
      env,
      fromTemporaryIsbOrgManagementCredentials(env),
    ),
  };
}

async function getPermissionSetContext(
  env: LeaseLambdaContext["env"],
  options?: { consistentRead?: boolean },
): Promise<PermissionSetContext> {
  return loadPermissionSetContext(
    IsbServices.idcStackConfigStore(env),
    IsbServices.principalStore(env),
    options,
  );
}

function projectLeasePermissionSets(props: {
  lease: PersistedLease;
  permissionSetContext: PermissionSetContext;
}) {
  const { lease, permissionSetContext } = props;
  return {
    ...lease,
    ...hydratePermissionSets(lease, permissionSetContext),
  };
}

function toPersistedLease(lease: PersistedLease): PersistedLease {
  return PersistedLeaseSchema.parse(lease);
}

function validationErrorsAsBadRequest<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ValidationException) {
      throw jsendError(400, error.message);
    }
    throw error;
  }
}

function normalizeAssignmentPermissionSets(props: {
  assignments: DesiredAssignment[];
  config: ResolvedPermissionSetConfig;
  permissionSetContext: PermissionSetContext;
}): DesiredAssignment[] {
  const { assignments, config, permissionSetContext } = props;
  const allowed = new Set([
    config.defaultPermissionSetArn,
    ...(config.allowedPermissionSetArns ?? []),
  ]);
  const seen = new Set<string>();

  return assignments.map((assignment) => {
    const permissionSetArn =
      assignment.permissionSetArn ?? config.defaultPermissionSetArn;
    if (isSystemPermissionSetArn(permissionSetArn, permissionSetContext)) {
      throw new ValidationException(
        `Permission set ${permissionSetArn} is a system role and cannot be assigned to lease users.`,
      );
    }
    if (!allowed.has(permissionSetArn)) {
      throw new ValidationException(
        `Permission set ${permissionSetArn} is not allowed by this lease.`,
      );
    }

    const principalKey = JSON.stringify([
      assignment.principalType,
      assignment.principalId,
    ]);
    if (seen.has(principalKey)) {
      throw new ValidationException(
        "Each principal may have only one permission set assignment.",
      );
    }
    seen.add(principalKey);

    return {
      ...assignment,
      permissionSetArn,
    };
  });
}

function assertPermissionSetNarrowingAllowed(props: {
  previous: PersistedLease;
  next: ResolvedPermissionSetConfig;
  permissionSetContext: PermissionSetContext;
}): void {
  const { previous, next, permissionSetContext } = props;
  const previousDefaultPermissionSetArn =
    previous.defaultPermissionSetArn ??
    permissionSetContext.idcConfig.userPermissionSetArn;
  const previousEffectiveArns = new Set([
    previousDefaultPermissionSetArn,
    ...(previous.allowedPermissionSetArns ?? []),
  ]);
  const nextEffectiveArns = new Set([
    next.defaultPermissionSetArn,
    ...(next.allowedPermissionSetArns ?? []),
  ]);
  const removedArns = new Set(
    [...previousEffectiveArns].filter((arn) => !nextEffectiveArns.has(arn)),
  );
  const legacyOwnerPermissionSetArn =
    permissionSetContext.idcConfig.userPermissionSetArn;

  if (
    (previous.desiredAssignments?.length ?? 0) === 0 &&
    removedArns.has(legacyOwnerPermissionSetArn)
  ) {
    throw jsendError(
      409,
      `Permission set ${legacyOwnerPermissionSetArn} is still used by the legacy owner assignment.`,
    );
  }

  const disallowedDesired = previous.desiredAssignments?.find((assignment) =>
    removedArns.has(
      assignment.permissionSetArn ?? previousDefaultPermissionSetArn,
    ),
  );
  if (disallowedDesired) {
    const permissionSetArn =
      disallowedDesired.permissionSetArn ?? previousDefaultPermissionSetArn;
    throw jsendError(
      409,
      `Permission set ${permissionSetArn} is still used by a desired assignment.`,
    );
  }
}

const PatchLeaseSchema = PersistedMonitoredLeaseSchema.pick({
  maxSpend: true,
  budgetThresholds: true,
  expirationDate: true,
  durationThresholds: true,
  costReportGroup: true,
  allowOwnerToShareLease: true,
  rateLimits: true,
  predictiveBudgetEnabled: true,
  bedrockTokenMonitoringEnabled: true,
  sandboxSpacesEnabled: true,
  allowedModelIds: true,
  defaultModelId: true,
  defaultPermissionSetArn: true,
  allowedPermissionSetArns: true,
})
  .extend({
    maxSpend: PersistedMonitoredLeaseSchema.shape.maxSpend.nullable(),
    expirationDate:
      PersistedMonitoredLeaseSchema.shape.expirationDate.nullable(),
    costReportGroup:
      PersistedMonitoredLeaseSchema.shape.costReportGroup.nullable(),
    rateLimits: PersistedMonitoredLeaseSchema.shape.rateLimits.nullable(),
    sandboxSpacesEnabled:
      PersistedMonitoredLeaseSchema.shape.sandboxSpacesEnabled.unwrap(),
    allowedModelIds:
      PersistedMonitoredLeaseSchema.shape.allowedModelIds.nullable(),
    defaultModelId:
      PersistedMonitoredLeaseSchema.shape.defaultModelId.nullable(),
  })
  .partial()
  .strict();

type LeasePatch = z.infer<typeof PatchLeaseSchema>;

function parseLeasePatch(context: LeasesSmithyContext): LeasePatch {
  const parseResponse = PatchLeaseSchema.safeParse(
    parseRawJsonBody(context.event),
  );
  if (!parseResponse.success) {
    throw createHttpJSendValidationError(parseResponse.error);
  }
  return parseResponse.data;
}

/**
 * Maps an explicit `null` (clear) to `undefined` so spreading the result over
 * the lease unsets the field. As for lease templates, sending
 * `predictiveBudgetEnabled: false` without `rateLimits` clears the stored
 * limits, since they could no longer fire.
 */
function leaseUpdatesFromPatch(
  patch: LeasePatch,
): Partial<PersistedMonitoredLease> {
  const updates: Partial<PersistedMonitoredLease> = Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [key, value ?? undefined]),
  );
  if (
    patch.predictiveBudgetEnabled === false &&
    !Object.hasOwn(patch, "rateLimits")
  ) {
    updates.rateLimits = undefined;
  }
  return updates;
}

function assertLeaseCanBeUpdated(
  lease: PersistedLease,
): asserts lease is PersistedMonitoredLease {
  if (!isMonitoredLease(lease)) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            message: `Can only update an active lease`,
          },
        ],
      },
    });
  }

  if (
    lease.resourceLock &&
    DateTime.fromISO(lease.resourceLock.expiresAt, { zone: "utc" }) >
      DateTime.utc()
  ) {
    throw jsendError(
      409,
      "Another operation is in progress on this lease. Please try again later.",
    );
  }
}

function hasPermissionSetPatch(patch: LeasePatch): boolean {
  return (
    Object.hasOwn(patch, "defaultPermissionSetArn") ||
    Object.hasOwn(patch, "allowedPermissionSetArns")
  );
}

function preserveLegacyDesiredAssignmentPermissionSets(props: {
  lease: PersistedMonitoredLease;
  previousDefaultPermissionSetArn: string;
  nextDefaultPermissionSetArn: string;
}): PersistedMonitoredLease {
  const {
    lease,
    previousDefaultPermissionSetArn,
    nextDefaultPermissionSetArn,
  } = props;
  if (nextDefaultPermissionSetArn === previousDefaultPermissionSetArn) {
    return lease;
  }
  return {
    ...lease,
    desiredAssignments: lease.desiredAssignments?.map((assignment) => ({
      ...assignment,
      permissionSetArn:
        assignment.permissionSetArn ?? previousDefaultPermissionSetArn,
    })),
  };
}

async function applyPermissionSetPatch(props: {
  existingLease: PersistedMonitoredLease;
  updatedLease: PersistedMonitoredLease;
  patch: LeasePatch;
  env: LeaseLambdaContext["env"];
}): Promise<{
  updatedLease: PersistedMonitoredLease;
  permissionSetContext?: PermissionSetContext;
}> {
  const { existingLease, updatedLease, patch, env } = props;
  if (!hasPermissionSetPatch(patch)) {
    return { updatedLease };
  }

  const permissionSetContext = await getPermissionSetContext(env, {
    consistentRead: true,
  });
  const permissionSetConfig = validationErrorsAsBadRequest(() =>
    resolvePermissionSetConfig(
      {
        defaultPermissionSetArn: patch.defaultPermissionSetArn,
        allowedPermissionSetArns: patch.allowedPermissionSetArns,
      },
      permissionSetContext,
      existingLease,
    ),
  );
  assertPermissionSetNarrowingAllowed({
    previous: existingLease,
    next: permissionSetConfig,
    permissionSetContext,
  });

  const previousDefaultPermissionSetArn =
    existingLease.defaultPermissionSetArn ??
    permissionSetContext.idcConfig.userPermissionSetArn;
  return {
    updatedLease: preserveLegacyDesiredAssignmentPermissionSets({
      lease: { ...updatedLease, ...permissionSetConfig },
      previousDefaultPermissionSetArn,
      nextDefaultPermissionSetArn: permissionSetConfig.defaultPermissionSetArn,
    }),
    permissionSetContext,
  };
}

async function validateLeaseUpdate(props: {
  updatedLease: PersistedMonitoredLease;
  existingLease: PersistedMonitoredLease;
  patch: LeasePatch;
  globalConfig: GlobalConfig;
  env: LeaseLambdaContext["env"];
  logger: Logger;
}): Promise<void> {
  const { updatedLease, existingLease, patch, globalConfig, env, logger } =
    props;
  if (
    Object.hasOwn(patch, "sandboxSpacesEnabled") ||
    Object.hasOwn(patch, "bedrockTokenMonitoringEnabled")
  ) {
    try {
      validateSandboxSpacesFields(updatedLease);
    } catch (error) {
      throwValidationErrorAs400(error);
    }
  }
  // Spend-rate limits are evaluated only against a projection, which a lease
  // without predictive controls never has, so a list there could never fire.
  if (
    (patch.rateLimits?.length ?? 0) > 0 &&
    updatedLease.predictiveBudgetEnabled !== true
  ) {
    throw jsendError(
      400,
      "rateLimits requires a lease with predictive budget controls enabled.",
    );
  }
  try {
    validateLeaseCompliesWithGlobalConfig(updatedLease, globalConfig, {
      previous: existingLease,
    });
    // Stored thresholds are checked only where this patch sends
    // predictiveBudgetEnabled, so they never block an unrelated edit.
    validatePredictiveBudgetFields({
      predictiveBudgetEnabled: updatedLease.predictiveBudgetEnabled,
      budgetThresholds: Object.hasOwn(patch, "predictiveBudgetEnabled")
        ? updatedLease.budgetThresholds
        : patch.budgetThresholds,
    });
    // Checked only where this patch sends maxSpend or budgetThresholds, so
    // stored thresholds never block an unrelated edit.
    if (
      Object.hasOwn(patch, "maxSpend") ||
      Object.hasOwn(patch, "budgetThresholds")
    ) {
      validateBudgetThresholdsBelowMaxSpend(updatedLease);
    }
    validateCostReportGroup(
      updatedLease.costReportGroup,
      globalConfig.costReporting,
      { previousCostReportGroup: existingLease.costReportGroup },
    );
  } catch (error) {
    throwValidationErrorAs400(error);
  }

  if ("allowedModelIds" in patch || "defaultModelId" in patch) {
    try {
      await assertSandboxSpacesModelSelection({
        resource: "lease",
        agentConfig: globalConfig.agent,
        allowedModelIds: updatedLease.allowedModelIds,
        previousAllowedModelIds: existingLease.allowedModelIds,
        defaultModelId: updatedLease.defaultModelId,
        configStore: IsbServices.configStore(env),
        logger,
      });
    } catch (error) {
      throwValidationErrorAs400(error);
    }
  }
}

async function persistLeaseUpdate(props: {
  leaseStore: ReturnType<typeof IsbServices.leaseStore>;
  updatedLease: PersistedMonitoredLease;
  existingLease: PersistedMonitoredLease;
}) {
  const { leaseStore, updatedLease, existingLease } = props;
  try {
    return await leaseStore.update(
      toPersistedLease(updatedLease),
      existingLease,
    );
  } catch (error) {
    if (error instanceof UnknownItem) {
      throw createHttpJSendError({
        statusCode: 404,
        data: {
          errors: [
            {
              message: `Lease not found.`,
            },
          ],
        },
      });
    }
    if (error instanceof ConcurrentDataModificationException) {
      throw jsendError(
        409,
        "The lease changed while this update was being processed. Retry with the latest lease state.",
      );
    }
    throw error;
  }
}

async function updateCostReportGroupTag(props: {
  existingLease: PersistedMonitoredLease;
  updatedLease: PersistedMonitoredLease;
  env: LeaseLambdaContext["env"];
  logger: Logger;
}): Promise<void> {
  const { existingLease, updatedLease, env, logger } = props;
  if (existingLease.costReportGroup === updatedLease.costReportGroup) {
    return;
  }

  try {
    const taggingService = IsbServices.organizationsTaggingService(
      env,
      fromTemporaryIsbOrgManagementCredentials(env),
    );
    await taggingService.tagAccount(updatedLease.awsAccountId, {
      CostReportGroup:
        updatedLease.costReportGroup ?? NO_COST_REPORT_GROUP_TAG_VALUE,
    });
  } catch (tagError) {
    logTaggingFailure(
      logger,
      updatedLease.awsAccountId,
      ["CostReportGroup"],
      tagError,
    );
  }
}

/**
 * Fetch a lease by its base64 composite-key `{leaseId}` label, logging a store
 * read error exactly as the pre-Smithy handler did. Does NOT throw on a missing
 * lease — callers decide 404 vs 403-before-404 (`terminateLease` authorizes first).
 */
async function fetchLease(
  leaseStore: ReturnType<typeof IsbServices.leaseStore>,
  leaseId: string,
  logger: Logger,
) {
  const leaseCompositeKey = parseLeaseCompositeKey(leaseId);
  const leaseResponse = await leaseStore.get(leaseCompositeKey);
  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${leaseCompositeKey.uuid}: ${leaseResponse.error}`,
    );
  }
  return { leaseCompositeKey, lease: leaseResponse.result };
}

/**
 * The read-access branch the lease reads share: a caller who is neither Admin nor
 * Manager gets 403 whether or not the lease exists, so existence is not leaked, and
 * only a caller who could have read the lease gets the 404.
 */
async function fetchLeaseWithReadAccessOrThrow(
  leaseId: string,
  forbiddenMessage: string,
  context: LeasesSmithyContext,
  logger: Logger,
): Promise<PersistedLease> {
  const { env, user } = context.lambdaContext;
  const leaseCompositeKey = parseLeaseCompositeKey(leaseId);

  const leaseResponse =
    await IsbServices.leaseStore(env).get(leaseCompositeKey);
  const lease = leaseResponse.result;
  if (leaseResponse.error) {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: Error retrieving lease ${leaseCompositeKey.uuid}: ${leaseResponse.error}`,
    );
  }

  const canRead =
    !!lease &&
    (await hasReadAccessForLease(user, lease, () =>
      IsbServices.principalStore(env),
    ));
  if (!canRead) {
    throw isAdminOrManager(user)
      ? jsendError(404, "Lease not found.")
      : jsendError(403, forbiddenMessage);
  }
  return lease;
}

/** `fetchLease` plus the shared 404 when the lease is absent. */
async function fetchLeaseOrThrow404(
  leaseStore: ReturnType<typeof IsbServices.leaseStore>,
  leaseId: string,
  logger: Logger,
) {
  const { lease } = await fetchLease(leaseStore, leaseId, logger);
  if (!lease) {
    throw jsendError(404, "Lease not found.");
  }
  return lease;
}

// ---------------------------------------------------------------------------
// Shared helpers (ported verbatim from the pre-Smithy handler)
// ---------------------------------------------------------------------------

/**
 * Decode the base64url `{leaseId}` label and re-parse it with `LeaseKeySchema`.
 * The model's `@pattern("^[A-Za-z0-9_-]+$")` on `LeaseId` already rejects a
 * label that is not URL-safe base64 (as the pre-Smithy `PathParametersSchema`
 * regex did), so this retained Zod supplement owns only the two remaining
 * checks: a base64 decode failure → the pre-Smithy 400, and the decoded
 * composite key failing `LeaseKeySchema` → the pre-Smithy validation 400.
 */
function parseLeaseCompositeKey(leaseId: string) {
  // leaseId is a base64url-encoded composite key (URL-safe alphabet, no padding).
  let decodedCompositeKey: Record<string, any> | undefined;
  try {
    decodedCompositeKey = base64DecodeCompositeKey(leaseId);
  } catch {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [{ message: "LeaseId path parameter provided is invalid." }],
      },
    });
  }

  const leaseKeySchemaParseResponse =
    LeaseKeySchema.safeParse(decodedCompositeKey);

  if (!leaseKeySchemaParseResponse.success)
    throw createHttpJSendValidationError(leaseKeySchemaParseResponse.error);

  return leaseKeySchemaParseResponse.data;
}

/**
 * Returns true if the user has read access to a lease.
 * Access is granted if the user is Admin/Manager, the lease owner,
 * or has shared access via desiredAssignments (direct user or group membership).
 */
async function hasReadAccessForLease(
  user: IsbUser,
  lease: PersistedLease,
  getPrincipalStore: () => ReturnType<typeof IsbServices.principalStore>,
): Promise<boolean> {
  // Admin/Manager can view any lease
  if (isAdminOrManager(user)) {
    return true;
  }

  // Owner or direct user assignment
  if (isLeaseOwnerOrDirectAssignee(user, lease)) {
    return true;
  }

  if (!isIdcUser(user) || !lease.desiredAssignments?.length) {
    return false;
  }

  const userId = user.userId;

  // Group-based assignment via cached group memberships
  const groupAssignments = lease.desiredAssignments.filter(
    (a) => a.principalType === "GROUP",
  );
  if (groupAssignments.length === 0) {
    return false;
  }

  const principalStore = getPrincipalStore();
  const membershipCache = await principalStore.getGroupMembershipCache(userId);
  const userGroupIds = membershipCache.result?.groupIds ?? [];
  if (userGroupIds.length === 0) {
    return false;
  }

  return groupAssignments.some((a) => userGroupIds.includes(a.principalId));
}

/**
 * Asserts the caller has permission to manage assignments for a lease.
 * Admin/Manager can always manage. Owner can manage only if lease sharing is
 * enabled globally and allowOwnerToShareLease is set on the lease.
 *
 * Callers must already have confirmed the caller is elevated or the lease
 * owner (see updateLeaseAssignments); this only enforces the sharing flags.
 */
function assertCallerCanManageAssignments(
  user: IsbUser,
  globalConfig: GlobalConfig,
  lease: PersistedLease,
): void {
  // Admin/Manager always have access regardless of global flag
  if (isAdminOrManager(user)) return;

  // For non-elevated owners, check the global flag
  if (!globalConfig.leases.leaseSharingEnabled) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [{ message: "Lease sharing is not enabled." }],
      },
    });
  }

  if (!lease.allowOwnerToShareLease) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [{ message: "Owner sharing is not enabled for this lease." }],
      },
    });
  }
}

function assertGroupAssignmentsAllowed(
  globalConfig: GlobalConfig,
  desiredAssignments: readonly DesiredAssignment[],
  options: {
    existingAssignments?: readonly DesiredAssignment[];
    message?: string;
  } = {},
): void {
  const {
    existingAssignments = [],
    message = "New group assignments are not enabled.",
  } = options;
  const disallowed = findDisallowedGroupAssignments(
    globalConfig.leases.groupAssignmentMode,
    desiredAssignments,
    existingAssignments,
  );
  if (disallowed.length === 0) return;

  throw createHttpJSendError({
    statusCode: 400,
    data: { errors: [{ message }] },
  });
}

/**
 * Throws 403 if a user-only caller is not permitted to terminate this lease.
 * Run before the 404 check so existence isn't leaked to unauthorized callers.
 */
function authorizeTermination(
  user: IsbUser,
  lease: PersistedLease | undefined,
  globalConfig: GlobalConfig,
): { isUserOnly: boolean } {
  if (isAdminOrManager(user)) return { isUserOnly: false };

  const forbidden = createHttpJSendError({
    statusCode: 403,
    data: {
      errors: [{ message: "User is not authorized to terminate this lease." }],
    },
  });

  if (globalConfig.leases.allowUserLeaseTermination !== true) throw forbidden;
  if (lease?.userEmail !== getUserEmail(user)) throw forbidden;
  if (lease.status === "Frozen" || lease.status === "Provisioning")
    throw forbidden;

  return { isUserOnly: true };
}

/**
 * Shared freeze / unfreeze error mapping: a held resource lock → 409, a missing
 * account or user → 404, anything else rethrows. The caller-specific
 * `AccountNotIn{Active,Frozen}Error` status guard is handled before this.
 */
function mapLeaseLockError(error: unknown): never {
  if (error instanceof ResourceLockConflictError) {
    throw jsendError(
      409,
      "Another operation is currently being processed for this lease. Try again once it completes.",
    );
  }
  if (
    error instanceof CouldNotFindAccountError ||
    error instanceof CouldNotRetrieveUserError
  ) {
    throw jsendError(404, error.message);
  }
  throw error;
}

/** Maps known terminateLease errors to HTTP responses; rethrows the rest. */
function mapTerminateError(error: unknown): never {
  if (error instanceof ResourceLockConflictError) {
    throw createHttpJSendError({
      statusCode: 409,
      data: {
        errors: [
          {
            message: "A termination is already being processed for this lease.",
          },
        ],
      },
    });
  }
  if (
    error instanceof CouldNotFindAccountError ||
    error instanceof CouldNotRetrieveUserError
  ) {
    throw createHttpJSendError({
      statusCode: 404,
      data: { errors: [{ message: error.message }] },
    });
  }
  throw error;
}

async function enforceLeaseRequestRateLimit(props: {
  logger: Logger;
  lambdaContext: LeaseLambdaContext;
  targetUserEmail: string;
  leaseStore: ReturnType<typeof IsbServices.leaseStore>;
}) {
  const { logger, lambdaContext, targetUserEmail, leaseStore } = props;

  // Admin/Manager callers are exempt from the rate limit.
  if (isAdminOrManager(lambdaContext.user)) {
    return;
  }

  const { leaseRequestWindowHours, maxLeaseRequestsPerWindow, ttl } =
    lambdaContext.globalConfig.leases;
  const ttlWindowHours = ttl * 24;
  const effectiveWindowHours = Math.min(
    leaseRequestWindowHours,
    ttlWindowHours,
  );
  if (
    leaseRequestWindowHours > ttlWindowHours &&
    !leaseRequestWindowCappedLogged
  ) {
    leaseRequestWindowCappedLogged = true;
    logger.warn("LeaseRequestWindowCapped", {
      logDetailType: "LeaseRequestWindowCapped",
      configuredWindowHours: leaseRequestWindowHours,
      ttlWindowHours,
      effectiveWindowHours,
    });
  }

  const windowStart = DateTime.utc().minus({ hours: effectiveWindowHours });
  const userLeases = await collect(
    stream(leaseStore, leaseStore.findByUserEmail, {
      userEmail: targetUserEmail,
    }),
  );

  const leasesInWindow = userLeases.filter((lease) => {
    if (
      lease.status === "PendingApproval" ||
      lease.status === "ApprovalDenied"
    ) {
      return false;
    }
    const createdTime = lease.meta?.createdTime;
    if (!createdTime) {
      return false;
    }
    return DateTime.fromISO(createdTime, { zone: "utc" }) >= windowStart;
  });

  if (leasesInWindow.length < maxLeaseRequestsPerWindow) {
    return;
  }

  // When count > limit (e.g. admin assignments pushed the user above the
  // limit), aging out only the earliest lease isn't enough to unblock.
  // Pick the Nth-oldest such that enough leases age out to drop the count
  // below the limit.
  const sortedTimes = leasesInWindow
    .map((lease) => lease.meta!.createdTime!)
    .sort((a, b) => a.localeCompare(b));
  const pivotIndex = leasesInWindow.length - maxLeaseRequestsPerWindow;
  const pivotTime = sortedTimes[pivotIndex];
  if (pivotTime === undefined) {
    throw new Error("Unable to determine the lease request retry time.");
  }
  const retryAt = DateTime.fromISO(pivotTime, { zone: "utc" })
    .plus({ hours: effectiveWindowHours })
    .toISO()!;

  logger.warn("LeaseRequestRateLimited", {
    logDetailType: "LeaseRequestRateLimited",
    targetUserEmail,
    callerEmail: getUserEmail(lambdaContext.user),
    currentCount: leasesInWindow.length,
    limit: maxLeaseRequestsPerWindow,
    retryAt,
    effectiveWindowHours,
  });

  throw new LeaseRequestRateLimitExceededError(
    `You have reached the maximum number of lease requests allowed within the rolling window (${maxLeaseRequestsPerWindow}). Try again at ${retryAt}.`,
    retryAt,
  );
}

async function validateAndGetLeaseTemplate(
  leaseTemplateUuid: string,
  requestingUser: IsbUser,
  isbContext: { leaseTemplateStore: LeaseTemplateStore },
) {
  const leaseTemplateResponse =
    await isbContext.leaseTemplateStore.get(leaseTemplateUuid);
  const leaseTemplate = leaseTemplateResponse.result;

  if (
    !leaseTemplate ||
    (leaseTemplate.visibility === "PRIVATE" &&
      !isAdminOrManager(requestingUser))
  ) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: "Lease template not found.",
          },
        ],
      },
    });
  }

  return leaseTemplate;
}

async function resolveTargetUser(
  userEmail: string | undefined,
  requestingUser: IsbUser,
  isbContext: IsbContext<{ idcService: IdcService }>,
): Promise<IsbUser> {
  // If no userEmail provided, use the requesting user
  if (!userEmail || userEmail === getUserEmail(requestingUser)) {
    return requestingUser;
  }

  // Cross-user lease creation - validate permissions
  if (!isAdminOrManager(requestingUser)) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [
          {
            message:
              "Access denied. You do not have permission to create leases for other users.",
          },
        ],
      },
    });
  }

  // Validate that the target user exists in IDC
  const userResponse =
    await isbContext.idcService.getIsbMemberFromEmail(userEmail);
  if (!userResponse) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: "User is not an eligible ISB member",
          },
        ],
      },
    });
  }

  return userResponse;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
function listLeases(logger: Logger) {
  return async (
    input: ListLeasesServerInput,
    context: LeasesSmithyContext,
  ): Promise<ListLeasesServerOutput> => {
    const { env, user } = context.lambdaContext;
    const leaseStore = IsbServices.leaseStore(env);

    // The model validates `maxResults` (`@range(min:1,max:2000)`); the deserializer
    // has already rejected an out-of-range or malformed integer. `userEmail` is
    // modeled as an open `@sensitive String` (`OwnerEmail`, no `@pattern`), so its
    // email format is a retained Zod supplement re-validated below. Unlike
    // `ListSharedLeases` (whose pre-Smithy `GetSharedLeasesQueryParametersSchema`
    // was `.strict()`), the pre-Smithy `GetLeasesQueryParametersSchema` was NOT
    // `.strict()` — it silently discarded unknown query params — so ignoring unknown
    // query params here MATCHES pre-Smithy and is not a deviation.
    const { pageIdentifier, maxResults, userEmail } = input;

    // Re-validate an explicit `userEmail` against the email format the pre-Smithy
    // query schema enforced (`z.email().optional()`), returning 400 BEFORE any
    // authorization or store access.
    if (userEmail !== undefined) {
      const userEmailParseResult = z.email().safeParse(userEmail);
      if (!userEmailParseResult.success) {
        throw createHttpJSendValidationError(userEmailParseResult.error);
      }
    }

    let findLeasesResponse;
    if (userEmail === undefined) {
      if (!isAdminOrManager(user)) {
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message: `User is not authorized to get all leases.`,
              },
            ],
          },
        });
      }
      findLeasesResponse = await leaseStore.findAll({
        pageIdentifier,
        pageSize: maxResults ?? LIST_LEASES_DEFAULT_MAX,
      });
    } else {
      if (!isAdminOrManager(user) && getUserEmail(user) !== userEmail) {
        logger.warn(
          `User ${getUserEmail(user)} not allowed to get leases of ${userEmail}`,
        );
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message: `User is not authorized to get the requested leases.`,
              },
            ],
          },
        });
      }
      findLeasesResponse = await leaseStore.findByUserEmail({
        userEmail,
        pageIdentifier,
        pageSize: maxResults ?? LIST_LEASES_DEFAULT_MAX,
      });
    }

    if (findLeasesResponse.error) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: Error finding leases - ${findLeasesResponse.error}`,
      );
    }

    const permissionSetContext = await getPermissionSetContext(env);
    const data = {
      ...findLeasesResponse,
      result: findLeasesResponse.result.map((lease: PersistedLease) => ({
        ...projectLeasePermissionSets({ lease, permissionSetContext }),
        leaseId: base64EncodeCompositeKey({
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        }),
      })),
    };

    // Return the raw store result (with injected `leaseId`s); the serializer
    // projects it to the modeled shape and forwards the optional `error`
    // diagnostic. The cast bridges the store types to the modeled output.
    return {
      status: JSendStatus.SUCCESS,
      data: data as unknown as ListLeasesServerOutput["data"],
    };
  };
}

function getLease(logger: Logger) {
  return async (
    input: GetLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<GetLeaseServerOutput> => {
    const { env } = context.lambdaContext;
    const lease = await fetchLeaseWithReadAccessOrThrow(
      input.leaseId,
      "Active user is not authorized to view leases of requested user.",
      context,
      logger,
    );
    const permissionSetContext = await getPermissionSetContext(env);

    return {
      status: JSendStatus.SUCCESS,
      data: {
        ...projectLeasePermissionSets({ lease, permissionSetContext }),
        leaseId: base64EncodeCompositeKey({
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        }),
        selectableModels: await selectableModelsForLease(lease, context),
      } as unknown as GetLeaseServerOutput["data"],
    };
  };
}

/**
 * Reads the catalog only when a Space can open for this lease (enabled globally
 * and on the lease); otherwise the member stays unset and ConfigTable is not read.
 * Resolved per read, not persisted, so disabling a model applies on the next fetch.
 */
async function selectableModelsForLease(
  lease: Pick<PersistedLease, "allowedModelIds" | "sandboxSpacesEnabled">,
  context: LeasesSmithyContext,
) {
  if (
    !context.lambdaContext.globalConfig.agent.sandboxSpacesEnabled ||
    !lease.sandboxSpacesEnabled
  ) {
    return undefined;
  }
  const catalogRows = await IsbServices.configStore(
    context.lambdaContext.env,
  ).getAgentModels();
  return selectableModelsForLeaseAccess(leaseModelAccess(lease), catalogRows);
}

function listSharedLeases(logger: Logger) {
  return async (
    input: ListSharedLeasesServerInput,
    context: LeasesSmithyContext,
  ): Promise<ListSharedLeasesServerOutput> => {
    const { env, user } = context.lambdaContext;

    // The model validates `userId` (required), `accessType` (required enum), and
    // `maxResults` (`@range(min:1,max:100)`); the deserializer rejected anything
    // invalid before this runs. `userId` is modeled as an open `String`, so its
    // `IdcPrincipalIdSchema` format is a retained Zod supplement (the pre-Smithy
    // query schema validated it and returned 400 on a non-conforming id). The
    // `.strict()` unknown-query rejection is not reproduced (accepted deviation).
    const { userId, accessType, pageIdentifier, maxResults } = input;

    const userIdParseResult = IdcPrincipalIdSchema.safeParse(userId);
    if (!userIdParseResult.success) {
      throw createHttpJSendValidationError(userIdParseResult.error);
    }

    // Admin/Manager can query shared leases for any user. Other callers must
    // be an IDC user querying their own userId — no cross-user observation.
    // M2M callers without elevated roles cannot use this endpoint.
    if (!isAdminOrManager(user)) {
      if (isM2MUser(user)) {
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message:
                  "Machine-to-machine clients without Admin/Manager role cannot query shared leases.",
              },
            ],
          },
        });
      }
      if (!isIdcUser(user) || user.userId !== userId) {
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message:
                  "Caller is not authorized to query shared leases for this user.",
              },
            ],
          },
        });
      }
    }

    const leaseStore = IsbServices.leaseStore(env);
    const principalStore = IsbServices.principalStore(env);

    const result = await (
      accessType === "direct"
        ? getLeasesForUserDirect(
            {
              userId,
              pageIdentifier,
              pageSize: maxResults ?? LIST_SHARED_LEASES_DEFAULT_MAX,
            },
            { leaseStore, principalStore, logger },
          )
        : getLeasesForUserViaGroups(
            {
              userId,
              pageIdentifier,
              pageSize: maxResults ?? LIST_SHARED_LEASES_DEFAULT_MAX,
            },
            {
              leaseStore,
              principalStore,
              idcService: IsbServices.idcService(
                env,
                fromTemporaryIsbIdcCredentials(env),
              ),
              logger,
            },
          )
    ).catch((error: unknown) => {
      if (error instanceof InvalidDirectLeasePageIdentifierError) {
        throw createHttpJSendError({
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
      throw error;
    });

    const permissionSetContext = await getPermissionSetContext(env);
    return {
      status: JSendStatus.SUCCESS,
      data: {
        result: result.result.map((lease) => ({
          ...projectLeasePermissionSets({ lease, permissionSetContext }),
          leaseId: base64EncodeCompositeKey({
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          }),
        })),
        nextPageIdentifier: result.nextPageIdentifier,
        ...(result.error === undefined ? {} : { error: result.error }),
      } as unknown as ListSharedLeasesServerOutput["data"],
    };
  };
}

function getLeaseAssignments(_logger: Logger) {
  return async (
    input: GetLeaseAssignmentsServerInput,
    context: LeasesSmithyContext,
  ): Promise<GetLeaseAssignmentsServerOutput> => {
    const { env, user } = context.lambdaContext;
    const leaseStore = IsbServices.leaseStore(env);
    const principalStore = IsbServices.principalStore(env);

    const leaseCompositeKey = parseLeaseCompositeKey(input.leaseId);

    // Fetch lease to validate existence and check ownership for authorization
    const { result: lease } = await leaseStore.get(leaseCompositeKey, {
      consistentRead: true,
    });

    // Admin/Manager can view any lease's assignments.
    // Other users can only view their own — and get 403 even if lease doesn't exist.
    if (!isAdminOrManager(user) && getUserEmail(user) !== lease?.userEmail) {
      throw createHttpJSendError({
        statusCode: 403,
        data: {
          errors: [
            {
              message:
                "Active user is not authorized to view assignments for this lease.",
            },
          ],
        },
      });
    } else if (!lease) {
      throw createHttpJSendError({
        statusCode: 404,
        data: {
          errors: [{ message: "Lease not found." }],
        },
      });
    }

    const assignments = await principalStore.getAssignmentsForLease({
      leaseId: lease.uuid,
    });
    const permissionSetContext = await getPermissionSetContext(env);
    const assignmentProjection = deriveAssignmentProjection({
      lease,
      assignments: assignments.result,
      builtInPermissionSetArn:
        permissionSetContext.idcConfig.userPermissionSetArn,
    });
    const data = {
      ...assignmentProjection,
      assignments: assignmentProjection.assignments.map(
        ({ permissionSetArn, ...assignment }) => ({
          ...assignment,
          permissionSet: hydratePermissionSetReference(
            permissionSetArn ??
              permissionSetContext.idcConfig.userPermissionSetArn,
            permissionSetContext,
          ),
        }),
      ),
    } satisfies GetLeaseAssignmentsServerOutput["data"];

    return {
      status: JSendStatus.SUCCESS,
      data,
    };
  };
}

function getLeaseCostSummary(logger: Logger) {
  return async (
    input: GetLeaseCostSummaryServerInput,
    context: LeasesSmithyContext,
  ): Promise<GetLeaseCostSummaryServerOutput> => {
    const lease = await fetchLeaseWithReadAccessOrThrow(
      input.leaseId,
      "Active user is not authorized to view the cost summary for this lease.",
      context,
      logger,
    );
    const data = await buildCostSummaryData(
      { lease },
      costHistoryServices(context, logger),
    );
    return {
      status: JSendStatus.SUCCESS,
      data: toCostSummaryOutput(data),
    };
  };
}

function getLeaseCostHistory(logger: Logger) {
  return async (
    input: GetLeaseCostHistoryServerInput,
    context: LeasesSmithyContext,
  ): Promise<GetLeaseCostHistoryServerOutput> => {
    const data = await readLeaseHistoryPage(
      input,
      "Active user is not authorized to view cost history for this lease.",
      buildCostHistoryData,
      context,
      logger,
    );
    return {
      status: JSendStatus.SUCCESS,
      data: toCostHistoryOutput(data),
    };
  };
}

function getLeaseBedrockTokenHistory(logger: Logger) {
  return async (
    input: GetLeaseBedrockTokenHistoryServerInput,
    context: LeasesSmithyContext,
  ): Promise<GetLeaseBedrockTokenHistoryServerOutput> => {
    const data = await readLeaseHistoryPage(
      input,
      "Active user is not authorized to view Bedrock token history for this lease.",
      buildBedrockTokenHistoryData,
      context,
      logger,
    );
    return {
      status: JSendStatus.SUCCESS,
      data: toBedrockTokenHistoryOutput(data),
    };
  };
}

function getLeaseBreachHistory(logger: Logger) {
  return async (
    input: GetLeaseBreachHistoryServerInput,
    context: LeasesSmithyContext,
  ): Promise<GetLeaseBreachHistoryServerOutput> => {
    const data = await readLeaseHistoryPage(
      input,
      "Active user is not authorized to view breach history for this lease.",
      buildBreachHistoryData,
      context,
      logger,
    );
    return {
      status: JSendStatus.SUCCESS,
      data: toBreachHistoryOutput(data),
    };
  };
}

/** The input the three lease history operations share. */
type LeaseHistoryPageInput =
  | GetLeaseCostHistoryServerInput
  | GetLeaseBedrockTokenHistoryServerInput
  | GetLeaseBreachHistoryServerInput;

/**
 * What the lease history reads share: the read-access check, the range, and the
 * 400 for a cursor the store refuses, which includes one from another history
 * route, since a cursor resumes only the row type it was cut from.
 */
async function readLeaseHistoryPage<Data>(
  input: LeaseHistoryPageInput,
  forbiddenMessage: string,
  build: (
    request: LeaseHistoryPageRequest,
    services: CostHistoryServices,
  ) => Promise<Data>,
  context: LeasesSmithyContext,
  logger: Logger,
): Promise<Data> {
  const lease = await fetchLeaseWithReadAccessOrThrow(
    input.leaseId,
    forbiddenMessage,
    context,
    logger,
  );

  const range = resolveCostHistoryRange(input, lease);

  try {
    return await build(
      {
        lease,
        maxResults: input.maxResults ?? COST_HISTORY_DEFAULT_MAX,
        ...(input.pageIdentifier === undefined
          ? {}
          : { pageIdentifier: input.pageIdentifier }),
        ...(range === undefined ? {} : { range }),
      },
      costHistoryServices(context, logger),
    );
  } catch (error) {
    if (error instanceof InvalidCostHistoryPageIdentifierError) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            { message: "pageIdentifier is not a valid pagination cursor." },
          ],
        },
      });
    }
    throw error;
  }
}

function costHistoryServices(
  context: LeasesSmithyContext,
  logger: Logger,
): CostHistoryServices {
  return {
    costHistoryStore: IsbServices.leaseCostHistoryStore(
      context.lambdaContext.env,
    ),
    logger,
  };
}

// A lease with no startDate was never monitored, so it has no observations for a
// floor to exclude; the epoch stands in where there is no start to fall back to.
const COST_HISTORY_RANGE_FLOOR = "1970-01-01T00:00:00.000Z";

/**
 * The range `afterTimestamp`/`beforeTimestamp` ask for, as the inclusive window
 * the store's `BETWEEN` takes and a cursor carries: the exclusive
 * `beforeTimestamp` becomes the millisecond before it. Bounds are normalized to
 * the fixed-width UTC millisecond timestamps the sort keys are compared against,
 * so an offset-bearing bound ("...+05:00") narrows to the instant it names rather
 * than being rejected. A one-sided range is filled here because the store takes
 * both bounds or neither: DynamoDB allows a single sort-key condition, and one
 * bound would have to be an open-ended comparison that also takes the other
 * types' rows on its side.
 */
function resolveCostHistoryRange(
  input: LeaseHistoryPageInput,
  lease: PersistedLease,
): { from: string; to: string } | undefined {
  // Read before the unbounded check rather than after it: a later page of a bounded
  // read can carry the window in its cursor alone, and treating that as unbounded
  // widens the range the cursor was cut against, which the store rejects as a
  // mismatched cursor.
  const continuationWindow = costHistoryCursorWindow(input.pageIdentifier);
  if (
    input.afterTimestamp === undefined &&
    input.beforeTimestamp === undefined &&
    continuationWindow === undefined
  ) {
    return undefined;
  }
  const requestedFrom = input.afterTimestamp ?? continuationWindow?.from;
  const from = normalizeRangeBound(
    requestedFrom ??
      ("startDate" in lease ? lease.startDate : COST_HISTORY_RANGE_FLOOR),
    "afterTimestamp",
  );
  const to = resolveInclusiveUpperBound(
    input.beforeTimestamp,
    continuationWindow,
  );
  if (from > to && requestedFrom === undefined) {
    // A lone upper bound at or before the lease start, such as the reading before
    // a range that opens before the lease did, asks for whatever precedes it, not
    // for an inverted range. One at or before the floor too has nothing before it.
    return { from: earlierInstant(to, COST_HISTORY_RANGE_FLOOR), to };
  }
  if (from > to) {
    // Rejected rather than returned empty: an afterTimestamp at or after
    // beforeTimestamp leaves the store's `BETWEEN` inverted, which matches
    // nothing, and an empty series would read as a lease that spent nothing over
    // the range.
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          { message: "afterTimestamp must be earlier than beforeTimestamp." },
        ],
      },
    });
  }
  return { from, to };
}

/**
 * The window's inclusive upper bound. A `beforeTimestamp` excludes its own
 * instant, so the window ends the millisecond before it; a cursor's window and
 * now are inclusive already.
 */
function resolveInclusiveUpperBound(
  beforeTimestamp: string | undefined,
  continuationWindow: { from: string; to: string } | undefined,
): string {
  if (beforeTimestamp === undefined) {
    return normalizeRangeBound(
      continuationWindow?.to ?? nowAsIsoDatetimeString(),
      "beforeTimestamp",
    );
  }
  const before = normalizeRangeBound(beforeTimestamp, "beforeTimestamp");
  // Normalized again because the millisecond before 0000-01-01T00:00:00.000Z
  // has no fixed-width spelling: that bound is a 400, not a window the store
  // throws on.
  return normalizeRangeBound(
    parseDatetime(before).minus({ milliseconds: 1 }).toISO()!,
    "beforeTimestamp",
  );
}

/** The earlier of two normalized ISO instants, which order as strings. */
function earlierInstant(first: string, second: string): string {
  if (first < second) {
    return first;
  }
  return second;
}

function costHistoryCursorWindow(
  pageIdentifier: string | undefined,
): { from: string; to: string } | undefined {
  if (pageIdentifier === undefined) {
    return undefined;
  }
  try {
    const cursor = base64DecodeCompositeKey(pageIdentifier, (decoded) =>
      CostHistoryPageIdentifierSchema.parse(decoded),
    );
    return cursor.window ?? undefined;
  } catch {
    // The store owns the static invalid-cursor error and its 400 mapping.
    return undefined;
  }
}

const OFFSET_SUFFIX = /[+-]\d{2}(?::?\d{2})?$/;

/**
 * Whether the value spells its own offset -- a trailing `Z`, or a `±hh[:mm]` after
 * the time. The time is sliced off by hand rather than skipped by the pattern: one
 * general enough to skip the date has to backtrack over it, and this reads a query
 * string the caller controls.
 */
function hasExplicitOffset(value: string): boolean {
  const separator = value.indexOf("T");
  if (separator === -1) {
    return false;
  }
  const timePart = value.slice(separator + 1);
  return timePart.endsWith("Z") || OFFSET_SUFFIX.test(timePart);
}

function normalizeRangeBound(value: string, memberName: string): string {
  const parsed = DateTime.fromISO(value, { setZone: true });
  const normalized =
    hasExplicitOffset(value) && parsed.isValid ? parsed.toUTC().toISO() : null;
  if (normalized === null || !IsoMillisSchema.safeParse(normalized).success) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [{ message: `${memberName} must be an ISO 8601 instant.` }],
      },
    });
  }
  return normalized;
}

/**
 * Every member of a shared cost-history contract type and of the generated shape
 * it maps to. Each mapper below names its members against this and returns the
 * generated type, so a member added on either side fails compilation until it is
 * mapped, rather than going missing from the response. The contract spells an
 * absent member `null` and the generated shape `undefined`; restJson1 omits both,
 * so `?? undefined` changes the type and not the wire.
 */
type EveryMember<Shared, Generated> = Record<
  keyof Shared | keyof Generated,
  unknown
>;

function toCostSummaryOutput(
  data: CostSummaryData,
): GetLeaseCostSummaryServerOutput["data"] {
  return {
    current: data.current
      ? toCostHistoryCurrentOutput(data.current)
      : undefined,
  } satisfies EveryMember<
    CostSummaryData,
    GetLeaseCostSummaryServerOutput["data"]
  >;
}

function toCostHistoryCurrentOutput(
  current: CostHistoryCurrent,
): SmithyCostHistoryCurrent {
  return {
    billedCostAccrued: current.billedCostAccrued,
    predictedCost: current.predictedCost,
    hourlyRate: current.hourlyRate ?? undefined,
    dailyRate: current.dailyRate ?? undefined,
    hourlyRateWindowHours: current.hourlyRateWindowHours ?? undefined,
    dailyRateWindowHours: current.dailyRateWindowHours ?? undefined,
    rateSource: current.rateSource ?? undefined,
    hoursToBudgetExhaustion: current.hoursToBudgetExhaustion ?? undefined,
    latestPeriodStart: current.latestPeriodStart,
    lastReportedAt: current.lastReportedAt,
    lastCheckedAt: current.lastCheckedAt,
    services: current.services.map(toCurrentServiceEntryOutput),
  } satisfies EveryMember<CostHistoryCurrent, SmithyCostHistoryCurrent>;
}

function toCurrentServiceEntryOutput(
  entry: CurrentServiceEntry,
): SmithyCurrentServiceEntry {
  return {
    service: entry.service,
    amount: entry.amount,
    shareOfBilledCost: entry.shareOfBilledCost,
    changePercent: entry.changePercent ?? undefined,
  } satisfies EveryMember<CurrentServiceEntry, SmithyCurrentServiceEntry>;
}

function toCostHistoryOutput(
  data: CostHistoryData,
): GetLeaseCostHistoryServerOutput["data"] {
  return {
    result: data.result.map(toCostHistoryResultRowOutput),
    nextPageIdentifier: data.nextPageIdentifier ?? undefined,
  } satisfies EveryMember<
    CostHistoryData,
    GetLeaseCostHistoryServerOutput["data"]
  >;
}

function toCostHistoryResultRowOutput(
  row: CostHistoryResultRow,
): SmithyCostHistoryResultRow {
  return {
    timestamp: row.timestamp,
    billedCostAccrued: row.billedCostAccrued,
    predictedCostAtRefresh: row.predictedCostAtRefresh ?? undefined,
    serviceBreakdown: row.serviceBreakdown,
  } satisfies EveryMember<CostHistoryResultRow, SmithyCostHistoryResultRow>;
}

function toBedrockTokenHistoryOutput(
  data: BedrockTokenHistoryData,
): GetLeaseBedrockTokenHistoryServerOutput["data"] {
  return {
    result: data.result.map(toTokenSeriesRowOutput),
    nextPageIdentifier: data.nextPageIdentifier ?? undefined,
  } satisfies EveryMember<
    BedrockTokenHistoryData,
    GetLeaseBedrockTokenHistoryServerOutput["data"]
  >;
}

function toTokenSeriesRowOutput(row: TokenSeriesRow): SmithyTokenSeriesRow {
  return {
    timestamp: row.timestamp,
    region: row.region,
    modelId: row.modelId,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    monitoredBedrockTokenCost: row.monitoredBedrockTokenCost,
  } satisfies EveryMember<TokenSeriesRow, SmithyTokenSeriesRow>;
}

function toBreachHistoryOutput(
  data: BreachHistoryData,
): GetLeaseBreachHistoryServerOutput["data"] {
  return {
    result: data.result.map(toBreachEntryOutput),
    nextPageIdentifier: data.nextPageIdentifier ?? undefined,
  } satisfies EveryMember<
    BreachHistoryData,
    GetLeaseBreachHistoryServerOutput["data"]
  >;
}

function toBreachEntryOutput(entry: BreachEntry): SmithyBreachEntry {
  return {
    timestamp: entry.timestamp,
    triggeredBy: entry.triggeredBy,
    action: entry.action,
    thresholdDollars: entry.thresholdDollars ?? undefined,
    thresholdRate: entry.thresholdRate ?? undefined,
    thresholdRateBasis: entry.thresholdRateBasis ?? undefined,
    thresholdHoursRemaining: entry.thresholdHoursRemaining ?? undefined,
    billedCostAtFire: entry.billedCostAtFire,
    predictedCostAtFire: entry.predictedCostAtFire ?? undefined,
    rateAtFire: entry.rateAtFire ?? undefined,
    rateSourceAtFire: entry.rateSourceAtFire ?? undefined,
    evaluatedBy: entry.evaluatedBy,
    evaluatedSpendAtFire: entry.evaluatedSpendAtFire ?? undefined,
    monitoredBedrockTokenCostAtFire:
      entry.monitoredBedrockTokenCostAtFire ?? undefined,
    insight: entry.insight ? toBreachInsightOutput(entry.insight) : undefined,
  } satisfies EveryMember<BreachEntry, SmithyBreachEntry>;
}

function toBreachInsightOutput(insight: BreachInsight): SmithyBreachInsight {
  return {
    kind: insight.kind,
    service: insight.service,
    amount: insight.amount,
    shareOfComparedSpend: insight.shareOfComparedSpend,
    changePercent: insight.changePercent,
  } satisfies EveryMember<BreachInsight, SmithyBreachInsight>;
}

// ---------------------------------------------------------------------------
// Lease request & update (body-bearing writes; keep a strict Zod re-parse)
// ---------------------------------------------------------------------------
function throwRequestLeaseError(
  error: unknown,
  maxLeasesPerUser: number,
): never {
  if (error instanceof MaxNumberOfLeasesExceededError) {
    throw createHttpJSendError({
      statusCode: 409,
      data: {
        errors: [
          {
            message: `You have reached the maximum number of active/pending leases allowed (${maxLeasesPerUser}).`,
          },
        ],
      },
    });
  }

  if (error instanceof NoAccountsAvailableError) {
    throw createHttpJSendError({
      statusCode: 409,
      data: {
        errors: [
          {
            message: `No accounts are available to lease.`,
          },
        ],
      },
    });
  }

  if (error instanceof LeaseRequestRateLimitExceededError) {
    throw createHttpJSendError({
      statusCode: 429,
      data: {
        errors: [{ message: error.message }],
        retryAt: error.retryAt,
      },
    });
  }

  if (error instanceof ValidationException) {
    throwValidationErrorAs400(error);
  }

  if (
    error instanceof MaxAssignmentsExceededError ||
    error instanceof IneligibleAssignmentPrincipalError ||
    error instanceof IneligibleLeaseOwnerError
  ) {
    throw jsendError(400, error.message);
  }

  throw error;
}

/**
 * The requester cannot fix a template, so a template-default rejection is
 * re-worded to point at whoever can.
 */
async function assertTemplateModelsRequestable(props: {
  leaseTemplate: PersistedLeaseTemplate;
  agentConfig: AgentConfig;
  configStore: ReturnType<typeof IsbServices.configStore>;
  logger: Logger;
}): Promise<void> {
  const { leaseTemplate, agentConfig, configStore, logger } = props;
  if (!leaseTemplate.sandboxSpacesEnabled) {
    return;
  }
  try {
    await assertSandboxSpacesModelSelection({
      resource: "lease",
      agentConfig,
      allowedModelIds: leaseTemplate.allowedModelIds,
      // The lease inherits the template's subset unchanged, so only the
      // default is checked; a disabled subset member is simply not offered.
      previousAllowedModelIds: leaseTemplate.allowedModelIds,
      defaultModelId: leaseTemplate.defaultModelId,
      configStore,
      logger,
    });
  } catch (error) {
    if (
      error instanceof ValidationException &&
      error.field === "defaultModelId"
    ) {
      throw new ValidationException(
        "This template's default model is no longer available. Contact an administrator to update the template.",
        { field: "defaultModelId" },
      );
    }
    throw error;
  }
}

function requestLease(logger: Logger) {
  return async (
    _input: RequestLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<RequestLeaseServerOutput> => {
    const { env, user, globalConfig } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      leaseTemplateStore: IsbServices.leaseTemplateStore(env),
      principalStore: IsbServices.principalStore(env),
      isbEventBridgeClient: IsbServices.isbEventBridge(env),
      globalConfig,
      blueprintStore: IsbServices.blueprintStore(env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(env),
    };

    // Retain the strict Zod re-parse (deviation #6): unknown-key rejection and
    // `DesiredAssignmentSchema.strict()`, which the model cannot express.
    // Principal uniqueness is checked after omitted permission-set ARNs resolve
    // to the concrete lease default.
    const InputLeaseSchema = PersistedPendingLeaseSchema.pick({
      comments: true,
    })
      .extend({
        leaseTemplateUuid:
          PersistedPendingLeaseSchema.shape.originalLeaseTemplateUuid,
        userEmail: PersistedPendingLeaseSchema.shape.userEmail.optional(),
        assignments: z
          .array(DesiredAssignmentSchema.strict())
          .max(MAX_ASSIGNMENTS)
          .optional(),
      })
      .strict();

    const leaseParseResponse = InputLeaseSchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!leaseParseResponse.success) {
      throw createHttpJSendValidationError(leaseParseResponse.error);
    }

    const { leaseTemplateUuid, userEmail, comments, assignments } =
      leaseParseResponse.data;

    assertGroupAssignmentsAllowed(globalConfig, assignments ?? []);

    // Resolve the assignee: an explicit userEmail (on-behalf) or the caller
    // (self-request). A lease grants IDC console access to its assignee, and M2M
    // identities have no IDC user, so refuse before any lookup or write.
    const assigneeEmail = userEmail ?? getUserEmail(user);
    rejectIfAssigneeIsM2m(assigneeEmail);

    const [leaseTemplate, targetUser] = await Promise.all([
      validateAndGetLeaseTemplate(leaseTemplateUuid, user, isbContext),
      resolveTargetUser(userEmail, user, isbContext),
    ]);

    // A request is a cross-user assignment only when userEmail identifies a
    // DIFFERENT user than the requester. A self-referential userEmail must be
    // treated the same as an omitted one, otherwise a regular user could set
    // createdBy (and thereby trigger auto-approval) on their own lease request.
    const createdBy =
      userEmail && userEmail !== getUserEmail(user)
        ? getUserEmail(user)
        : undefined;

    const hasSharedAssignments =
      isIdcUser(targetUser) &&
      assignments?.some(
        (assignment) =>
          assignment.principalType !== "USER" ||
          assignment.principalId !== targetUser.userId,
      );
    if (
      !globalConfig.leases.leaseSharingEnabled &&
      hasSharedAssignments &&
      !isAdminOrManager(user)
    ) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            {
              message: "Lease sharing is not enabled.",
            },
          ],
        },
      });
    }

    if (
      !leaseTemplate.allowOwnerToShareLease &&
      hasSharedAssignments &&
      !isAdminOrManager(user)
    ) {
      throw createHttpJSendError({
        statusCode: 403,
        data: {
          errors: [
            {
              message: "Owner sharing is not enabled for this lease template.",
            },
          ],
        },
      });
    }

    try {
      await assertTemplateModelsRequestable({
        leaseTemplate,
        agentConfig: globalConfig.agent,
        configStore: IsbServices.configStore(env),
        logger,
      });
      await enforceLeaseRequestRateLimit({
        logger,
        lambdaContext: context.lambdaContext,
        targetUserEmail: getUserEmail(targetUser),
        leaseStore: isbContext.leaseStore,
      });

      const permissionSetContext = await loadPermissionSetContext(
        IsbServices.idcStackConfigStore(env),
        IsbServices.principalStore(env),
        { consistentRead: true },
      );
      const permissionSetConfig = resolvePermissionSetConfig(
        leaseTemplate,
        permissionSetContext,
      );
      const normalizedAssignments = assignments
        ? normalizeAssignmentPermissionSets({
            assignments,
            config: permissionSetConfig,
            permissionSetContext,
          })
        : undefined;

      const newLease: PersistedLease = await InnovationSandbox.requestLease(
        {
          leaseTemplate,
          targetUser: targetUser,
          createdBy,
          comments,
          assignments: normalizedAssignments,
          permissionSetConfig,
        },
        isbContext,
      );

      return {
        status: JSendStatus.SUCCESS,
        data: projectLeasePermissionSets({
          lease: newLease,
          permissionSetContext,
        }) as unknown as RequestLeaseServerOutput["data"],
      };
    } catch (error) {
      throwRequestLeaseError(error, globalConfig.leases.maxLeasesPerUser);
    }
  };
}

function updateLease(logger: Logger) {
  return async (
    input: UpdateLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<UpdateLeaseServerOutput> => {
    const { env, globalConfig } = context.lambdaContext;
    const leaseStore = IsbServices.leaseStore(env);

    // Retain the strict PATCH schema (deviation #6): unknown-key rejection,
    // null-to-clear on the nullable members, and cross-field budget/duration
    // rules the model cannot express. Re-parse the raw body.
    const leasePatch = parseLeasePatch(context);

    // Map explicit `null` (clear) to `undefined` so the spread below unsets the
    // field. `value` is only ever a present value or explicit `null` here (Zod
    // `.partial()` drops absent keys), so `?? undefined` is equivalent to the
    // `=== null ? undefined : value` normalization.
    const leaseUpdates = leaseUpdatesFromPatch(leasePatch);

    const existingLease = await fetchLeaseOrThrow404(
      leaseStore,
      input.leaseId,
      logger,
    );

    assertLeaseCanBeUpdated(existingLease);

    const permissionSetPatch = await applyPermissionSetPatch({
      existingLease,
      updatedLease: { ...existingLease, ...leaseUpdates },
      patch: leasePatch,
      env,
    });
    const { updatedLease } = permissionSetPatch;
    await validateLeaseUpdate({
      updatedLease,
      existingLease,
      patch: leasePatch,
      globalConfig,
      env,
      logger,
    });

    const permissionSetContext =
      permissionSetPatch.permissionSetContext ??
      (await getPermissionSetContext(env));
    const putResult = await persistLeaseUpdate({
      leaseStore,
      updatedLease,
      existingLease,
    });

    logger.info(
      `Updated Lease ${existingLease.uuid}`,
      summarizeUpdate(putResult),
    );

    // Re-apply the CostReportGroup tag if it changed.
    await updateCostReportGroupTag({
      existingLease,
      updatedLease,
      env,
      logger,
    });

    return {
      status: JSendStatus.SUCCESS,
      data: projectLeasePermissionSets({
        lease: putResult.newItem,
        permissionSetContext,
      }) as unknown as UpdateLeaseServerOutput["data"],
    };
  };
}

// ---------------------------------------------------------------------------
// Lifecycle actions
// ---------------------------------------------------------------------------
function reviewLease(logger: Logger) {
  return async (
    input: ReviewLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<ReviewLeaseServerOutput> => {
    const { env, user, globalConfig } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      principalStore: IsbServices.principalStore(env),
      isbEventBridgeClient: IsbServices.isbEventBridge(env),
      globalConfig,
      blueprintStore: IsbServices.blueprintStore(env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(env),
      leaseTemplateStore: IsbServices.leaseTemplateStore(env),
    };

    // Retain the strict review-body Zod re-parse: the model validates `action`
    // (`Approve`/`Deny`, required enum), but the pre-Smithy handler ALSO rejected
    // unknown keys with an "Unrecognized key" 400, which `restJson1` would silently
    // drop. Re-parsing the raw body preserves that exact 400 (byte-faithful,
    // matching the pre-Smithy handler's `ReviewLeaseBodySchema.strict()`).
    const ReviewLeaseBodySchema = z
      .object({
        action: z.enum(["Approve", "Deny"], {
          error: enumErrorMap,
        }),
      })
      .strict();
    const parsedReviewLeaseBody = ReviewLeaseBodySchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!parsedReviewLeaseBody.success) {
      throw createHttpJSendValidationError(parsedReviewLeaseBody.error);
    }
    const action = parsedReviewLeaseBody.data.action;

    const lease = await fetchLeaseOrThrow404(
      isbContext.leaseStore,
      input.leaseId,
      logger,
    );

    if (!isPendingLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: LEASE_NOT_PENDING_REVIEW_ERROR,
            },
          ],
        },
      });
    }

    if (action == "Approve") {
      // Saved profiles may have become unavailable while approval was pending.
      // The worker reports grant failures so assignments can be repaired afterward.
      try {
        await InnovationSandbox.approveLease(
          { lease, approver: getUserEmail(user) },
          isbContext,
        );
      } catch (error) {
        if (error instanceof NoAccountsAvailableError) {
          throw createHttpJSendError({
            statusCode: 409,
            data: {
              errors: [
                {
                  message: `There are no more sandbox accounts available. Please contact your administrator.`,
                },
              ],
            },
          });
        } else if (
          error instanceof IneligibleAssignmentPrincipalError ||
          error instanceof IneligibleLeaseOwnerError
        ) {
          throw jsendError(400, error.message);
        } else {
          throw error;
        }
      }
    } else {
      await InnovationSandbox.denyLease({ lease, denier: user }, isbContext);
    }

    // Pre-Smithy body was `{"status":"success","data":null}`. The model omits
    // `data` (Smithy cannot model a null-only member), so the serialized body is
    // `{"status":"success"}` — an accepted deviation (matches `DeleteLeaseTemplate`).
    return { status: JSendStatus.SUCCESS };
  };
}

function freezeLease(logger: Logger) {
  return async (
    input: FreezeLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<FreezeLeaseServerOutput> => {
    const { env, user } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      eventBridgeClient: IsbServices.isbEventBridge(env),
    };

    const lease = await fetchLeaseOrThrow404(
      isbContext.leaseStore,
      input.leaseId,
      logger,
    );

    if (!isMonitoredLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: `Only active leases can be frozen.`,
            },
          ],
        },
      });
    }

    try {
      await InnovationSandbox.freezeLease(
        {
          lease,
          reason: {
            type: "ManuallyFrozen",
            comment: `Manually frozen by ${getUserEmail(user)}`,
          },
        },
        isbContext,
      );
    } catch (error) {
      if (error instanceof AccountNotInActiveError) {
        throw jsendError(409, error.message);
      }
      mapLeaseLockError(error);
    }

    // `data: null` pre-Smithy; `data` omitted from the model (accepted deviation).
    return { status: JSendStatus.SUCCESS };
  };
}

function terminateLease(logger: Logger) {
  return async (
    input: TerminateLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<TerminateLeaseServerOutput> => {
    const { env, user, globalConfig } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      eventBridgeClient: IsbServices.isbEventBridge(env),
      globalConfig,
      blueprintStore: IsbServices.blueprintStore(env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(env),
      sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(env),
    };

    const { lease } = await fetchLease(
      isbContext.leaseStore,
      input.leaseId,
      logger,
    );

    // 403 (authorization) is evaluated BEFORE the 404 so a lease's existence is
    // never leaked to an unauthorized caller.
    const { isUserOnly } = authorizeTermination(user, lease, globalConfig);

    if (!lease) {
      throw jsendError(404, "Lease not found.");
    }

    if (!isMonitoredLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: `Only [${MonitoredLeaseStatusSchema.options.join(", ")}] leases can be terminated.`,
            },
          ],
        },
      });
    }

    try {
      await InnovationSandbox.terminateLease(
        {
          lease,
          expiredStatus: isUserOnly ? "UserTerminated" : "ManuallyTerminated",
        },
        isbContext,
      );
    } catch (error) {
      mapTerminateError(error);
    }

    // `data: null` pre-Smithy; `data` omitted from the model (accepted deviation).
    return { status: JSendStatus.SUCCESS };
  };
}

function unfreezeLease(logger: Logger) {
  return async (
    input: UnfreezeLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<UnfreezeLeaseServerOutput> => {
    const { env } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      eventBridgeClient: IsbServices.isbEventBridge(env),
    };

    const leaseCompositeKey = parseLeaseCompositeKey(input.leaseId);
    const leaseResponse = await isbContext.leaseStore.get(leaseCompositeKey);
    const lease = leaseResponse.result;

    if (!lease || leaseResponse.error) {
      logger.warn(
        `Error retrieving lease ${leaseCompositeKey.uuid}: ${leaseResponse.error}`,
      );
      throw createHttpJSendError({
        statusCode: 404,
        data: {
          errors: [
            {
              message: `Lease not found.`,
            },
          ],
        },
      });
    }

    if (!isFrozenLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: `Only frozen leases can be unfrozen.`,
            },
          ],
        },
      });
    }

    // Unfreeze proceeds even when a profile is unavailable. The worker checks
    // each grant and reports failures so assignments can be repaired while Active.
    const permissionSetContext = await getPermissionSetContext(env);

    try {
      // Read before the write so a catalog failure cannot leave the lease
      // unfrozen while the client sees an error.
      const selectableModels = await selectableModelsForLease(lease, context);
      const result = await InnovationSandbox.unfreezeLease(
        { lease },
        isbContext,
      );
      return {
        status: JSendStatus.SUCCESS,
        data: {
          ...projectLeasePermissionSets({
            lease: result.newItem,
            permissionSetContext,
          }),
          leaseId: base64EncodeCompositeKey({
            userEmail: result.newItem.userEmail,
            uuid: result.newItem.uuid,
          }),
          selectableModels,
        } as unknown as UnfreezeLeaseServerOutput["data"],
      };
    } catch (error) {
      if (error instanceof AccountNotInFrozenError) {
        throw jsendError(409, error.message);
      }
      mapLeaseLockError(error);
    }
  };
}

function updateLeaseAssignments(logger: Logger) {
  return async (
    input: UpdateLeaseAssignmentsServerInput,
    context: LeasesSmithyContext,
  ): Promise<UpdateLeaseAssignmentsServerOutput> => {
    const { env, user, globalConfig } = context.lambdaContext;
    const leaseStore = IsbServices.leaseStore(env);

    // Retain the strict PUT body schema (deviation #6): unknown-key rejection and
    // per-principal uniqueness the model cannot express. Re-parse the raw body.
    const PutLeaseAssignmentsBodySchema = z
      .object({
        assignments: z
          .array(
            z
              .object({
                principalId: IdcPrincipalIdSchema,
                principalType: PrincipalTypeSchema,
                permissionSetArn:
                  DesiredAssignmentSchema.shape.permissionSetArn,
              })
              .strict(),
          )
          .max(MAX_ASSIGNMENTS)
          .refine(
            (items) => {
              const keys = items.map((i) =>
                JSON.stringify([i.principalType, i.principalId]),
              );
              return new Set(keys).size === keys.length;
            },
            {
              message:
                "Each principal may have only one permission set assignment.",
            },
          ),
      })
      .strict();

    const bodyParseResult = PutLeaseAssignmentsBodySchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!bodyParseResult.success) {
      throw createHttpJSendValidationError(bodyParseResult.error);
    }

    const { assignments: requestedAssignments } = bodyParseResult.data;

    // Get the lease
    const leaseCompositeKey = parseLeaseCompositeKey(input.leaseId);
    const { result: lease } = await leaseStore.get(leaseCompositeKey, {
      consistentRead: true,
    });

    // Admin/Manager can manage any lease's assignments.
    // Other users can only manage their own — and get 403 even if the lease
    // doesn't exist, so existence cannot be inferred from the status code.
    if (!isAdminOrManager(user) && getUserEmail(user) !== lease?.userEmail) {
      throw createHttpJSendError({
        statusCode: 403,
        data: {
          errors: [
            {
              message:
                "Active user is not authorized to manage assignments for this lease.",
            },
          ],
        },
      });
    } else if (!lease) {
      throw createHttpJSendError({
        statusCode: 404,
        data: {
          errors: [{ message: "Lease not found." }],
        },
      });
    }

    // Authorization check (global flag + owner sharing) for owner/elevated callers
    assertCallerCanManageAssignments(user, globalConfig, lease);

    // NONE prevents introducing a new group ID to the lease. Existing groups
    // may still add, replace, or remove permission-set tuples.
    assertGroupAssignmentsAllowed(globalConfig, requestedAssignments, {
      existingAssignments: lease.desiredAssignments ?? [],
    });

    // Lease must be Active
    if (!isActiveLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [{ message: "Lease is not in an active status." }],
        },
      });
    }

    // Delegate to service
    const callerEmail = getUserEmail(user);
    const principalStore = IsbServices.principalStore(env);
    // A removal or an unchanged replacement must not depend on catalog health.
    // Load registration only if the complete, owner-inclusive set adds a tuple.
    const permissionSetContext: PermissionSetContext = {
      idcConfig: await IsbServices.idcStackConfigStore(env).get(),
      cacheByArn: new Map(),
    };
    const { permissionSetConfig, desiredAssignments } =
      validationErrorsAsBadRequest(() => {
        const permissionSetConfig = resolvePermissionSetConfig(
          {},
          permissionSetContext,
          lease,
        );
        return {
          permissionSetConfig,
          desiredAssignments: normalizeAssignmentPermissionSets({
            assignments: requestedAssignments,
            config: permissionSetConfig,
            permissionSetContext,
          }),
        };
      });

    logger.info("Processing PUT assignments request", {
      leaseId: lease.uuid,
      callerEmail,
      desiredCount: desiredAssignments.length,
    });

    try {
      const idcService = IsbServices.idcService(
        env,
        fromTemporaryIsbIdcCredentials(env),
      );
      const owner = await idcService.getCachedPrincipalByAttr(
        "USER",
        lease.userEmail,
        principalStore,
        logger,
      );
      if (owner?.principalType !== "USER" || !owner.email) {
        throw new IneligibleLeaseOwnerError(lease.userEmail);
      }
      const assignmentsWithOwner = normalizeAssignmentsWithOwner({
        assignments: desiredAssignments,
        ownerPrincipalId: owner.principalId,
        defaultPermissionSetArn: permissionSetConfig.defaultPermissionSetArn,
      });
      await validateNewAssignmentGrants(
        {
          assignments: assignmentsWithOwner,
          previousAssignments: lease.desiredAssignments,
          defaultPermissionSetArn: permissionSetConfig.defaultPermissionSetArn,
        },
        { idcConfig: permissionSetContext.idcConfig, principalStore },
      );
      const { desiredCount } = await triggerAssignmentProcessing(
        {
          leaseId: lease.uuid,
          userEmail: lease.userEmail,
          intent: "UPDATE",
          requestedBy: callerEmail,
          desiredAssignments: assignmentsWithOwner,
          resolvedOwner: {
            ...owner,
            principalType: "USER",
            email: owner.email,
          },
          defaultPermissionSetArn: permissionSetConfig.defaultPermissionSetArn,
          expectedLease: lease,
        },
        {
          leaseStore: IsbServices.leaseStore(env),
          eventBridgeClient: IsbServices.isbEventBridge(env),
          principalStore,
          idcService,
          tracer,
          logger,
        },
      );

      logger.info("Assignment update accepted", {
        leaseId: lease.uuid,
        desiredCount,
        intent: "UPDATE",
      });

      return {
        status: JSendStatus.SUCCESS,
        data: { desiredCount },
      };
    } catch (error: unknown) {
      if (
        error instanceof MaxAssignmentsExceededError ||
        error instanceof IneligibleAssignmentPrincipalError ||
        error instanceof IneligibleLeaseOwnerError ||
        error instanceof ValidationException
      ) {
        throw createHttpJSendError({
          statusCode: 400,
          data: { errors: [{ message: error.message }] },
        });
      }
      if (error instanceof ResourceLockConflictError) {
        throw jsendError(
          409,
          "Another operation is currently being processed for this lease. Try again once it completes.",
        );
      }
      if (error instanceof ConcurrentDataModificationException) {
        throw jsendError(
          409,
          "Lease state changed after assignment validation. Refresh the lease and retry.",
        );
      }
      if (error instanceof UnknownItem) {
        throw jsendError(404, "Lease not found.");
      }
      throw error;
    }
  };
}

/**
 * The `LeasesApi` service. Every operation is wrapped in `withDelegatedErrors`
 * so the 400/403/404/409/429 business errors render through the shared Middy
 * `httpErrorHandler` exactly as the pre-Smithy handler produced them.
 */
export function leasesService(
  logger: Logger,
): LeasesApiService<LeasesSmithyContext> {
  return {
    ListLeases: withDelegatedErrors(listLeases(logger)),
    RequestLease: withDelegatedErrors(requestLease(logger)),
    ListSharedLeases: withDelegatedErrors(listSharedLeases(logger)),
    GetLease: withDelegatedErrors(getLease(logger)),
    UpdateLease: withDelegatedErrors(updateLease(logger)),
    FreezeLease: withDelegatedErrors(freezeLease(logger)),
    ReviewLease: withDelegatedErrors(reviewLease(logger)),
    TerminateLease: withDelegatedErrors(terminateLease(logger)),
    UnfreezeLease: withDelegatedErrors(unfreezeLease(logger)),
    GetLeaseAssignments: withDelegatedErrors(getLeaseAssignments(logger)),
    UpdateLeaseAssignments: withDelegatedErrors(updateLeaseAssignments(logger)),
    GetLeaseCostSummary: withDelegatedErrors(getLeaseCostSummary(logger)),
    GetLeaseCostHistory: withDelegatedErrors(getLeaseCostHistory(logger)),
    GetLeaseBedrockTokenHistory: withDelegatedErrors(
      getLeaseBedrockTokenHistory(logger),
    ),
    GetLeaseBreachHistory: withDelegatedErrors(getLeaseBreachHistory(logger)),
  };
}
