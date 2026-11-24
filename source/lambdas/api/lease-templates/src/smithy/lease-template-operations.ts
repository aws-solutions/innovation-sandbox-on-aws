// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";
import { z, type RefinementCtx } from "zod";

import type {
  CreateLeaseTemplateServerInput,
  CreateLeaseTemplateServerOutput,
  DeleteLeaseTemplateServerInput,
  DeleteLeaseTemplateServerOutput,
  GetLeaseTemplateServerInput,
  GetLeaseTemplateServerOutput,
  LeaseTemplate as LeaseTemplateOutput,
  LeaseTemplatesApiService,
  ListLeaseTemplatesServerInput,
  ListLeaseTemplatesServerOutput,
  UpdateLeaseTemplateServerInput,
  UpdateLeaseTemplateServerOutput,
} from "@amzn/innovation-sandbox-api-server/lease-templates";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/lease-templates";
import {
  ConcurrentDataModificationException,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  validateBudgetThresholdsBelowMaxSpend,
  validateLeaseTemplateCompliesWithGlobalConfig,
  validatePredictiveBudgetFields,
  validateSandboxSpacesFields,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import {
  PersistedLeaseTemplate,
  PersistedLeaseTemplateMetadataSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { validateCostReportGroup } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config-utils.js";
import { assertSandboxSpacesModelSelection } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/index.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { LeaseTemplateLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
  throwValidationErrorAs400,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { parseRawJsonBody } from "@amzn/innovation-sandbox-commons/lambda/smithy/parse-raw-json-body.js";
import {
  addCorrelationContext,
  LogPatterns,
  searchableLeaseTemplateProperties,
  summarizeUpdate,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { LeaseTemplateWritableSchema } from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { getUserEmail } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

import {
  hydratePermissionSets,
  loadPermissionSetContext,
  PermissionSetContext,
  resolvePermissionSetConfig,
} from "@amzn/innovation-sandbox-commons/isb-services/permission-set/index.js";
import {
  authorizedToGetPrivateLeaseTemplates,
  resolveBlueprintName,
} from "@amzn/innovation-sandbox-lease-templates/lease-template-helpers.js";

export type LeaseTemplateSmithyContext =
  IsbSmithyContext<LeaseTemplateLambdaEnvironment>;

/**
 * Spend-rate limits are evaluated only against a projection, so a non-empty
 * list sent with predictive controls off could never fire. The PREDICTED
 * budget-threshold rule is owned by `validatePredictiveBudgetFields`.
 */
function requirePredictiveForRateLimits(
  template: { predictiveBudgetEnabled: boolean; rateLimits?: unknown[] },
  ctx: RefinementCtx,
): void {
  if (
    !template.predictiveBudgetEnabled &&
    template.rateLimits !== undefined &&
    template.rateLimits.length > 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["rateLimits"],
      message: "rateLimits requires predictiveBudgetEnabled",
    });
  }
}

/**
 * Request bodies keep the pre-Smithy Zod contract. Smithy validates what the model
 * can express (required, length, `@range`, enum, type) before the operation runs;
 * these schemas run inside the operation and catch only what the model cannot:
 *  - `strictObject` unknown-key rejection (restJson1 silently drops unknown members);
 *  - refined formats — `blueprintId`'s UUID rule, `description`'s FreeText rule;
 *  - `.gt(0)` positivity on the `Double` amount/duration fields (`maxSpend`,
 *    `leaseDurationInHours`, threshold `dollarsSpent`/`hoursRemaining`) — the
 *    inclusive-only `@range` cannot express `.gt(0)`, so the model leaves them
 *    unconstrained (see `main.smithy`) and Zod owns the bound;
 *  - a non-empty `rateLimits` list requires `predictiveBudgetEnabled` (the
 *    `PREDICTED` budget-threshold rule is `validatePredictiveBudgetFields`').
 * `POST` also rejects `meta`; `PUT` accepts it, matching the pre-Smithy `omit` sets.
 */

// An omitted flag parses to its `false` default before the gate runs.
const createRequestSchema = LeaseTemplateWritableSchema.superRefine(
  requirePredictiveForRateLimits,
);

// The predictive gate is not applied here: an omitted flag means "keep the
// stored value", which is only known once the existing template is loaded.
// `updatePredictiveGateSchema` applies the gate to the resolved flag instead.
const updateRequestSchema = LeaseTemplateWritableSchema.extend({
  meta: PersistedLeaseTemplateMetadataSchema.optional(),
});

const updatePredictiveGateSchema = z
  .object({
    predictiveBudgetEnabled: z.boolean(),
    rateLimits: z.array(z.unknown()).optional(),
  })
  .superRefine(requirePredictiveForRateLimits);

type PredictiveFields = Pick<
  PersistedLeaseTemplate,
  "predictiveBudgetEnabled" | "rateLimits"
>;

function hasOwnKey(body: unknown, key: string): boolean {
  return typeof body === "object" && body !== null && Object.hasOwn(body, key);
}

/**
 * Reads which keys the raw body carries, since the parsed body cannot tell an
 * omitted key from a sent default (`predictiveBudgetEnabled` parses to false).
 * Omission rules are documented on the UpdateLeaseTemplate Smithy operation.
 */
function resolveUpdatePredictiveFields(
  rawBody: unknown,
  parsed: PredictiveFields,
  existing: PredictiveFields,
): PredictiveFields {
  const predictiveBudgetEnabled = hasOwnKey(rawBody, "predictiveBudgetEnabled")
    ? parsed.predictiveBudgetEnabled
    : existing.predictiveBudgetEnabled;
  if (hasOwnKey(rawBody, "rateLimits")) {
    return { predictiveBudgetEnabled, rateLimits: parsed.rateLimits };
  }
  return {
    predictiveBudgetEnabled,
    rateLimits: predictiveBudgetEnabled ? existing.rateLimits : undefined,
  };
}

/**
 * Adapts a persisted `PersistedLeaseTemplate` (the commons Zod type, whose `meta`
 * timestamps are ISO strings) into `LeaseTemplateOutput` — the generated Smithy
 * `LeaseTemplate` shape the operations return as their `data`. Both are "a lease
 * template"; the only real change is the two `meta` timestamps, which the generated
 * serializer's `serializeDateTime` requires as JS `Date`s, so the stored ISO strings
 * are parsed to `Date` here. Permission-set ARNs are hydrated into the generated
 * response references; persistence-only ARN fields are not serialized.
 *
 * On the wire the serializer then alphabetizes members, drops `null`s, and
 * normalizes the timestamp form (`.000Z` → `Z`) — deviations from the pre-Smithy
 * wire that are accepted, since no consumer depends on them (the frontend adapter
 * parses into typed objects and canonicalizes null/absent).
 */
function toLeaseTemplateOutput(
  template: PersistedLeaseTemplate,
  permissionSetContext: PermissionSetContext,
): LeaseTemplateOutput {
  // LeaseTemplateOutput validates the transformed values. Requiring every
  // persisted key makes optional members mandatory in this mapping, so adding a
  // persisted field fails compilation until the adapter handles it explicitly.
  type ExhaustiveLeaseTemplateOutputMapping = LeaseTemplateOutput &
    Record<keyof PersistedLeaseTemplate, unknown>;

  const mapped = {
    uuid: template.uuid,
    name: template.name,
    description: template.description,
    requiresApproval: template.requiresApproval,
    createdBy: template.createdBy,
    visibility: template.visibility,
    maxSpend: template.maxSpend,
    budgetThresholds: template.budgetThresholds,
    leaseDurationInHours: template.leaseDurationInHours,
    durationThresholds: template.durationThresholds,
    costReportGroup: template.costReportGroup,
    blueprintId: template.blueprintId ?? undefined,
    blueprintName: template.blueprintName ?? undefined,
    allowOwnerToShareLease: template.allowOwnerToShareLease,
    predictiveBudgetEnabled: template.predictiveBudgetEnabled,
    bedrockTokenMonitoringEnabled: template.bedrockTokenMonitoringEnabled,
    sandboxSpacesEnabled: template.sandboxSpacesEnabled,
    allowedModelIds: template.allowedModelIds,
    defaultModelId: template.defaultModelId,
    rateLimits: template.rateLimits,
    // Keep the persistence-only fields explicit for exhaustive mapping. The
    // generated serializer drops them and emits the hydrated references below.
    defaultPermissionSetArn: template.defaultPermissionSetArn,
    allowedPermissionSetArns: template.allowedPermissionSetArns,
    ...hydratePermissionSets(template, permissionSetContext),
    meta: template.meta
      ? {
          createdTime: template.meta.createdTime
            ? DateTime.fromISO(template.meta.createdTime, {
                zone: "utc",
              }).toJSDate()
            : undefined,
          lastEditTime: template.meta.lastEditTime
            ? DateTime.fromISO(template.meta.lastEditTime, {
                zone: "utc",
              }).toJSDate()
            : undefined,
          schemaVersion: template.meta.schemaVersion,
        }
      : undefined,
  } satisfies ExhaustiveLeaseTemplateOutputMapping;

  return mapped;
}

function listLeaseTemplates(logger: Logger) {
  return async (
    input: ListLeaseTemplatesServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<ListLeaseTemplatesServerOutput> => {
    const { lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );
    const permissionSetContext = await loadPermissionSetContext(
      IsbServices.idcStackConfigStore(lambdaContext.env),
      IsbServices.principalStore(lambdaContext.env),
    );

    // No extra Zod parsing is required here: unlike create/update there is no
    // request body, and the whole input (`maxResults`, `pageIdentifier`) is
    // captured by the model, so the generated deserializer/validator has already
    // rejected anything invalid before this runs. Default `maxResults` to 2000
    // when absent, matching the pre-Smithy pagination default.
    const { result, nextPageIdentifier, error } =
      // Filter PRIVATE templates out at the query layer for non-elevated users so
      // that neither the result set nor the pagination token can disclose a
      // PRIVATE template's UUID.
      await leaseTemplateStore.findAllVisible({
        pageIdentifier: input.pageIdentifier,
        pageSize: input.maxResults ?? 2000,
        includePrivate: authorizedToGetPrivateLeaseTemplates(
          lambdaContext.user,
        ),
      });

    if (error) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: Error while fetching lease templates - ${error}`,
      );
    }

    return {
      status: JSendStatus.SUCCESS,
      data: {
        result: result.map((template) =>
          toLeaseTemplateOutput(template, permissionSetContext),
        ),
        nextPageIdentifier: nextPageIdentifier ?? undefined,
      },
    };
  };
}

function createLeaseTemplate(logger: Logger) {
  return async (
    _input: CreateLeaseTemplateServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<CreateLeaseTemplateServerOutput> => {
    const { event, lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );

    // Model validation (required/length/enum/type) already passed. This Zod parse
    // of the raw body applies the pre-Smithy defaults and is the sole owner of what
    // the model cannot express — `strictObject` unknown keys, refined formats
    // (`blueprintId` UUID, `description` FreeText), and `.gt(0)` positivity on the
    // unconstrained `Double` amount/duration fields (see `createRequestSchema`
    // above). Its failures become the pre-Smithy validation error.
    const parsedBodyResult = createRequestSchema.safeParse(
      parseRawJsonBody(event),
    );
    if (!parsedBodyResult.success) {
      throw createHttpJSendValidationError(parsedBodyResult.error);
    }
    const requestData = parsedBodyResult.data;

    try {
      validateLeaseTemplateCompliesWithGlobalConfig(
        requestData,
        lambdaContext.globalConfig,
      );
      validatePredictiveBudgetFields(requestData);
      validateBudgetThresholdsBelowMaxSpend(requestData);
      validateSandboxSpacesFields(requestData);
      validateCostReportGroup(
        requestData.costReportGroup,
        lambdaContext.globalConfig.costReporting,
      );
    } catch (error) {
      throwValidationErrorAs400(error);
    }

    const permissionSetContext = await loadPermissionSetContext(
      IsbServices.idcStackConfigStore(lambdaContext.env),
      IsbServices.principalStore(lambdaContext.env),
      { consistentRead: true },
    );
    let permissionSetConfig;
    try {
      permissionSetConfig = resolvePermissionSetConfig(
        requestData,
        permissionSetContext,
      );
    } catch (error) {
      throwValidationErrorAs400(error);
    }

    await assertSandboxSpacesModelSelection({
      resource: "template",
      agentConfig: lambdaContext.globalConfig.agent,
      allowedModelIds: requestData.allowedModelIds,
      previousAllowedModelIds: undefined,
      defaultModelId: requestData.defaultModelId,
      configStore: IsbServices.configStore(lambdaContext.env),
      logger,
    }).catch(throwValidationErrorAs400);

    const blueprintName = await resolveBlueprintName(
      requestData.blueprintId,
      lambdaContext.env,
    );

    const newLeaseTemplate = await leaseTemplateStore.create({
      uuid: randomUUID(),
      createdBy: getUserEmail(lambdaContext.user),
      ...requestData,
      ...permissionSetConfig,
      blueprintName,
    });

    addCorrelationContext(
      logger,
      searchableLeaseTemplateProperties(newLeaseTemplate),
    );

    logger.info(
      `Created new LeaseTemplate (${newLeaseTemplate.name}) (${newLeaseTemplate.uuid})`,
      summarizeUpdate({ oldItem: undefined, newItem: newLeaseTemplate }),
    );

    return {
      status: JSendStatus.SUCCESS,
      data: toLeaseTemplateOutput(newLeaseTemplate, permissionSetContext),
    };
  };
}

function getLeaseTemplate(logger: Logger) {
  return async (
    input: GetLeaseTemplateServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<GetLeaseTemplateServerOutput> => {
    const { lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );

    const leaseTemplateResponse = await leaseTemplateStore.get(
      input.leaseTemplateId,
    );
    const leaseTemplate = leaseTemplateResponse.result;
    if (leaseTemplateResponse.error) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: Error retrieving lease template ${input.leaseTemplateId}: ${leaseTemplateResponse.error}`,
      );
    }

    if (
      !leaseTemplate ||
      (leaseTemplate.visibility === "PRIVATE" &&
        !authorizedToGetPrivateLeaseTemplates(lambdaContext.user))
    ) {
      throw createHttpJSendError({
        statusCode: 404,
        data: { errors: [{ message: "Lease template not found." }] },
      });
    }

    const permissionSetContext = await loadPermissionSetContext(
      IsbServices.idcStackConfigStore(lambdaContext.env),
      IsbServices.principalStore(lambdaContext.env),
    );

    return {
      status: JSendStatus.SUCCESS,
      data: toLeaseTemplateOutput(leaseTemplate, permissionSetContext),
    };
  };
}

function updateLeaseTemplate(logger: Logger) {
  return async (
    input: UpdateLeaseTemplateServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<UpdateLeaseTemplateServerOutput> => {
    const { event, lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );

    // As in `createLeaseTemplate`: model validation already ran; this Zod parse
    // owns what the model cannot express — `strictObject` unknown keys, refined
    // formats (`blueprintId` UUID, `description` FreeText), and `.gt(0)` positivity
    // on the unconstrained `Double` fields (see `updateRequestSchema` above).
    const rawBody = parseRawJsonBody(event);
    const parsedBodyResult = updateRequestSchema.safeParse(rawBody);
    if (!parsedBodyResult.success) {
      throw createHttpJSendValidationError(parsedBodyResult.error);
    }

    // Fetch the existing template so config-compliance validation is
    // change-aware: a required-but-missing field (cost report group, max budget,
    // duration) shouldn't block edits to unrelated fields on a template that
    // predates the requirement.
    const existingTemplateResponse = await leaseTemplateStore.get(
      input.leaseTemplateId,
    );
    const existingTemplate = existingTemplateResponse.result;

    if (!existingTemplate) {
      throw createHttpJSendError({
        statusCode: 404,
        data: { errors: [{ message: `Lease Template not found.` }] },
      });
    }

    // Gate the list as sent against the flag as it will be stored, so an
    // omitted flag on a predictive template still accepts it, and an explicit
    // off switch beside a non-empty list is rejected, not dropped. The
    // PREDICTED-threshold rule below reads the same effective flag.
    const predictiveFields = resolveUpdatePredictiveFields(
      rawBody,
      parsedBodyResult.data,
      existingTemplate,
    );
    const gateResult = updatePredictiveGateSchema.safeParse({
      predictiveBudgetEnabled: predictiveFields.predictiveBudgetEnabled,
      rateLimits: parsedBodyResult.data.rateLimits,
    });
    if (!gateResult.success) {
      throw createHttpJSendValidationError(gateResult.error);
    }
    const requestData = { ...parsedBodyResult.data, ...predictiveFields };

    try {
      validateLeaseTemplateCompliesWithGlobalConfig(
        requestData,
        lambdaContext.globalConfig,
        { previous: existingTemplate },
      );
      validatePredictiveBudgetFields(requestData);
      validateBudgetThresholdsBelowMaxSpend(requestData, {
        previous: existingTemplate,
      });
      validateSandboxSpacesFields(requestData);
      validateCostReportGroup(
        requestData.costReportGroup,
        lambdaContext.globalConfig.costReporting,
        { previousCostReportGroup: existingTemplate.costReportGroup },
      );
    } catch (error) {
      throwValidationErrorAs400(error);
    }

    const permissionSetContext = await loadPermissionSetContext(
      IsbServices.idcStackConfigStore(lambdaContext.env),
      IsbServices.principalStore(lambdaContext.env),
      { consistentRead: true },
    );
    let permissionSetConfig;
    try {
      permissionSetConfig = resolvePermissionSetConfig(
        parsedBodyResult.data,
        permissionSetContext,
        existingTemplate,
      );
    } catch (error) {
      throwValidationErrorAs400(error);
    }

    await assertSandboxSpacesModelSelection({
      resource: "template",
      agentConfig: lambdaContext.globalConfig.agent,
      allowedModelIds: parsedBodyResult.data.allowedModelIds,
      previousAllowedModelIds: existingTemplate.allowedModelIds,
      defaultModelId: parsedBodyResult.data.defaultModelId,
      configStore: IsbServices.configStore(lambdaContext.env),
      logger,
    }).catch(throwValidationErrorAs400);

    const resolvedBlueprintName = await resolveBlueprintName(
      parsedBodyResult.data.blueprintId,
      lambdaContext.env,
    );

    // createdBy is server-owned: absent from the request schema and restored
    // here from the persisted record.
    const leaseTemplate = {
      uuid: input.leaseTemplateId,
      ...requestData,
      createdBy: existingTemplate.createdBy,
      ...permissionSetConfig,
      blueprintName: resolvedBlueprintName,
    };

    // Conditioned on the record read above: every check here ran against it,
    // so a concurrent edit is rejected rather than silently replaced or retried.
    let result;
    try {
      result = await leaseTemplateStore.update(leaseTemplate, existingTemplate);
    } catch (error) {
      if (error instanceof UnknownItem) {
        throw createHttpJSendError({
          statusCode: 404,
          data: { errors: [{ message: `Lease Template not found.` }] },
        });
      }
      if (error instanceof ConcurrentDataModificationException) {
        throw createHttpJSendError({
          statusCode: 409,
          data: {
            errors: [
              {
                message:
                  "The lease template changed while this update was being processed. Refresh the template and retry.",
              },
            ],
          },
        });
      }
      throw error;
    }

    logger.info(
      `Updated LeaseTemplate (${leaseTemplate.name})(${leaseTemplate.uuid})`,
      summarizeUpdate(result),
    );

    return {
      status: JSendStatus.SUCCESS,
      data: toLeaseTemplateOutput(result.newItem, permissionSetContext),
    };
  };
}

function deleteLeaseTemplate(logger: Logger) {
  return async (
    input: DeleteLeaseTemplateServerInput,
    context: LeaseTemplateSmithyContext,
  ): Promise<DeleteLeaseTemplateServerOutput> => {
    const { lambdaContext } = context;
    const leaseTemplateStore = IsbServices.leaseTemplateStore(
      lambdaContext.env,
    );

    const itemId = input.leaseTemplateId;
    const deletedItem = await leaseTemplateStore.delete(itemId);
    if (deletedItem) {
      logger.info(
        `deleted lease template (${itemId})`,
        summarizeUpdate({ oldItem: deletedItem }),
      );
    } else {
      logger.info(
        `attempted to delete lease template (${itemId}), but it did not exist`,
      );
    }

    // The pre-Smithy body was `{"status":"success","data":null}`; the model output is
    // `{status}` only and the `data: null` is no longer restored — an accepted
    // deviation (the DELETE response body is not consumed by any client).
    return { status: JSendStatus.SUCCESS };
  };
}

/**
 * The five-operation `LeaseTemplatesApi` service. Conventional Smithy on the
 * inside — the mux routes, the model validates, the generated serializer writes
 * the body; the pre-Smithy request/response contract is preserved by the Zod
 * checks above and by `convertToIsbResponse` in the Lambda handler.
 */
export function leaseTemplateService(
  logger: Logger,
): LeaseTemplatesApiService<LeaseTemplateSmithyContext> {
  return {
    ListLeaseTemplates: withDelegatedErrors(listLeaseTemplates(logger)),
    CreateLeaseTemplate: withDelegatedErrors(createLeaseTemplate(logger)),
    GetLeaseTemplate: withDelegatedErrors(getLeaseTemplate(logger)),
    UpdateLeaseTemplate: withDelegatedErrors(updateLeaseTemplate(logger)),
    DeleteLeaseTemplate: withDelegatedErrors(deleteLeaseTemplate(logger)),
  };
}
