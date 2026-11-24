// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";

import {
  RegisterBlueprintRequestSchema,
  UpdateBlueprintRequestSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-request-schemas.js";
import { BlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import { PersistedStackSetItem } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { BlueprintLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { parseRawJsonBody } from "@amzn/innovation-sandbox-commons/lambda/smithy/parse-raw-json-body.js";
import {
  addCorrelationContext,
  searchableBlueprintProperties,
  summarizeUpdate,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { getUserEmail } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

import type {
  BlueprintsApiService,
  DeleteBlueprintServerInput,
  DeleteBlueprintServerOutput,
  GetBlueprintServerInput,
  GetBlueprintServerOutput,
  ListBlueprintsServerInput,
  ListBlueprintsServerOutput,
  ListStackSetsServerInput,
  ListStackSetsServerOutput,
  RegisterBlueprintServerInput,
  RegisterBlueprintServerOutput,
  UpdateBlueprintServerInput,
  UpdateBlueprintServerOutput,
} from "@amzn/innovation-sandbox-api-server/blueprints";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/blueprints";

export type BlueprintsSmithyContext =
  IsbSmithyContext<BlueprintLambdaEnvironment>;

// Pre-Smithy pagination defaults. Both list operations used
// `createPaginationQueryStringParametersSchema({ maxPageSize: 100 })`, whose
// `maxResults` default is the max (100). The model validates the range
// (`@range(min:1,max:100)`); the operation applies the default when `maxResults`
// is absent — defaults are operation behavior, not model traits (mirrors the
// Accounts/Leases `LIST_*_DEFAULT_MAX` consts).
const LIST_BLUEPRINTS_DEFAULT_MAX = 100;
const LIST_STACKSETS_DEFAULT_MAX = 100;

// The strict Register/Update request schemas (deviation #6) live in commons
// (`blueprint-request-schemas`) so the model-parity suite compares the Smithy
// inputs against this exact runtime schema — see the operations' `safeParse` calls.

/** Fetch a blueprint composite by id, throwing the shared 404 when absent. */
async function getBlueprintOr404(
  blueprintStore: BlueprintStore,
  blueprintId: string,
) {
  const result = await blueprintStore.get(blueprintId);
  if (!result.result) {
    throw createHttpJSendError({
      statusCode: 404,
      data: { errors: [{ message: "Blueprint not found" }] },
    });
  }
  return result.result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
function listStackSets(logger: Logger) {
  return async (
    input: ListStackSetsServerInput,
    context: BlueprintsSmithyContext,
  ): Promise<ListStackSetsServerOutput> => {
    const { env } = context.lambdaContext;
    const blueprintDeploymentService =
      IsbServices.blueprintDeploymentService(env);

    const response = await blueprintDeploymentService.listStackSets({
      pageIdentifier: input.pageIdentifier,
      pageSize: input.maxResults ?? LIST_STACKSETS_DEFAULT_MAX,
    });

    logger.info("StackSets retrieved for blueprint registration", {
      count: response.stackSets.length,
      hasNextPageIdentifier: !!response.nextPageIdentifier,
    });

    // `StackSetName`/`StackSetId` are part of every CloudFormation StackSet summary;
    // the AWS SDK only types them optional defensively. They map to `@required`
    // model members, so assert their presence here — a clear, intentional error if
    // CloudFormation ever violated that — rather than letting the generated serializer
    // reject the missing required member as an opaque 500.
    const result = response.stackSets.map((stackSet) => {
      if (!stackSet.StackSetName || !stackSet.StackSetId) {
        throw new Error(
          "CloudFormation returned a StackSet summary without StackSetName/StackSetId",
        );
      }
      return {
        stackSetName: stackSet.StackSetName,
        stackSetId: stackSet.StackSetId,
        description: stackSet.Description,
        status: stackSet.Status,
        permissionModel: stackSet.PermissionModel,
      };
    });

    return {
      status: JSendStatus.SUCCESS,
      data: {
        result,
        nextPageIdentifier: response.nextPageIdentifier,
      },
    };
  };
}

function listBlueprints(logger: Logger) {
  return async (
    input: ListBlueprintsServerInput,
    context: BlueprintsSmithyContext,
  ): Promise<ListBlueprintsServerOutput> => {
    const { env } = context.lambdaContext;
    const blueprintStore = IsbServices.blueprintStore(env);

    const blueprints = await blueprintStore.listBlueprints({
      pageIdentifier: input.pageIdentifier,
      pageSize: input.maxResults ?? LIST_BLUEPRINTS_DEFAULT_MAX,
    });

    logger.info("Blueprints retrieved", {
      count: blueprints.result.length,
      hasNextPageIdentifier: !!blueprints.nextPageIdentifier,
    });

    // Pre-Smithy returns the collection under `blueprints` (not `result`). The
    // serializer projects each composite to its modeled shape (internal
    // `PK`/`SK`/`itemType` dropped).
    return {
      status: JSendStatus.SUCCESS,
      data: {
        blueprints: blueprints.result,
        nextPageIdentifier: blueprints.nextPageIdentifier,
      } as unknown as ListBlueprintsServerOutput["data"],
    };
  };
}

function getBlueprint(logger: Logger) {
  return async (
    input: GetBlueprintServerInput,
    context: BlueprintsSmithyContext,
  ): Promise<GetBlueprintServerOutput> => {
    const { env } = context.lambdaContext;
    const blueprintStore = IsbServices.blueprintStore(env);

    const blueprintWithStackSets = await getBlueprintOr404(
      blueprintStore,
      input.blueprintId,
    );

    logger.info("Blueprint retrieved", {
      blueprintId: blueprintWithStackSets.blueprint.blueprintId,
      name: blueprintWithStackSets.blueprint.name,
    });

    return {
      status: JSendStatus.SUCCESS,
      data: blueprintWithStackSets as unknown as GetBlueprintServerOutput["data"],
    };
  };
}

// ---------------------------------------------------------------------------
// Register & update (body-bearing writes; strict Zod re-parse)
// ---------------------------------------------------------------------------
function registerBlueprint(logger: Logger) {
  return async (
    _input: RegisterBlueprintServerInput,
    context: BlueprintsSmithyContext,
  ): Promise<RegisterBlueprintServerOutput> => {
    const { env, user } = context.lambdaContext;

    const parsedBody = RegisterBlueprintRequestSchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!parsedBody.success) {
      throw createHttpJSendValidationError(parsedBody.error);
    }

    const userEmail = getUserEmail(user);
    const blueprintStore = IsbServices.blueprintStore(env);
    const blueprintDeploymentService =
      IsbServices.blueprintDeploymentService(env);

    const blueprint = await blueprintDeploymentService.registerBlueprint(
      {
        name: parsedBody.data.name,
        stackSetId: parsedBody.data.stackSetId,
        regions: parsedBody.data.regions,
        tags: parsedBody.data.tags,
        deploymentTimeoutMinutes: parsedBody.data.deploymentTimeoutMinutes,
        regionConcurrencyType: parsedBody.data.regionConcurrencyType,
        maxConcurrentPercentage: parsedBody.data.maxConcurrentPercentage,
        failureTolerancePercentage: parsedBody.data.failureTolerancePercentage,
        concurrencyMode: parsedBody.data.concurrencyMode,
        createdBy: userEmail,
      },
      blueprintStore,
    );

    addCorrelationContext(
      logger,
      searchableBlueprintProperties({ blueprint, stackSets: [] }),
    );
    logger.info(
      `Created new Blueprint (${blueprint.name}) (${blueprint.blueprintId})`,
    );

    return {
      status: JSendStatus.SUCCESS,
      data: blueprint as unknown as RegisterBlueprintServerOutput["data"],
    };
  };
}

function updateBlueprint(logger: Logger) {
  return async (
    input: UpdateBlueprintServerInput,
    context: BlueprintsSmithyContext,
  ): Promise<UpdateBlueprintServerOutput> => {
    const { env } = context.lambdaContext;

    const parsedBody = UpdateBlueprintRequestSchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!parsedBody.success) {
      throw createHttpJSendValidationError(parsedBody.error);
    }

    const blueprintStore = IsbServices.blueprintStore(env);
    const { blueprint, stackSets } = await getBlueprintOr404(
      blueprintStore,
      input.blueprintId,
    );

    // Separate persisted blueprint fields from persisted StackSet fields.
    const {
      maxConcurrentPercentage,
      failureTolerancePercentage,
      concurrencyMode,
      ...blueprintFields
    } = parsedBody.data;

    const hasStackSetUpdates =
      maxConcurrentPercentage !== undefined ||
      failureTolerancePercentage !== undefined ||
      concurrencyMode !== undefined;

    let updatedBlueprintWithStackSets;

    if (hasStackSetUpdates && stackSets.length > 0) {
      // Update the persisted blueprint and StackSet atomically; use the returned
      // composite directly.
      const updatedBlueprint = { ...blueprint, ...blueprintFields };
      const stackSet = stackSets[0]; // Current release: single StackSet.
      const updatedStackSet: PersistedStackSetItem = {
        ...stackSet,
        ...(maxConcurrentPercentage !== undefined && {
          maxConcurrentPercentage,
        }),
        ...(failureTolerancePercentage !== undefined && {
          failureTolerancePercentage,
        }),
        ...(concurrencyMode !== undefined && { concurrencyMode }),
      } as PersistedStackSetItem;

      updatedBlueprintWithStackSets =
        await blueprintStore.updateBlueprintWithStackSet(
          updatedBlueprint,
          updatedStackSet,
        );

      logger.info("Blueprint updated successfully", {
        blueprintId: blueprint.blueprintId,
        updatedFields: Object.keys(parsedBody.data),
      });
    } else {
      // Update only persisted blueprint fields, then re-fetch the composite.
      //
      // KNOWN RACE (preserved from the pre-Smithy handler, not introduced here):
      // this is a read-modify-write — the item was read via `getBlueprintOr404`
      // above and this `update` is an unconditional put, with no optimistic-lock
      // guard (version/condition). A concurrent writer between the read and this
      // put is a lost update. Faithfully carried over as capture-as-is; adding a
      // conditional write is tracked as a separate follow-up. The StackSet branch
      // above does not share this gap — `updateBlueprintWithStackSet` is a single
      // atomic transaction.
      const updatedBlueprint = { ...blueprint, ...blueprintFields };
      const updateResult = await blueprintStore.update(updatedBlueprint);
      // Re-fetch through the shared 404 guard rather than the raw `get`. `data` is a
      // `@required` output member, so a missing composite (the blueprint was deleted
      // between this `update` and the re-fetch) must surface as a clean 404 — not the
      // opaque restJson1 serializer 500 a cast-away `undefined` would produce.
      // Documented deviation: the pre-Smithy handler serialized `data: undefined` to a
      // 200 with the key omitted; a 404 is the correct outcome for "the resource no
      // longer exists" and no consumer relied on the degenerate 200. See
      // internal/docs/design-docs/smithy/accepted-deviations.md.
      updatedBlueprintWithStackSets = await getBlueprintOr404(
        blueprintStore,
        input.blueprintId,
      );

      logger.info("Blueprint updated successfully", {
        blueprintId: blueprint.blueprintId,
        ...summarizeUpdate({
          oldItem: updateResult.oldItem,
          newItem: updateResult.newItem,
        }),
      });
    }

    return {
      status: JSendStatus.SUCCESS,
      data: updatedBlueprintWithStackSets as unknown as UpdateBlueprintServerOutput["data"],
    };
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
function deleteBlueprint(logger: Logger) {
  return async (
    input: DeleteBlueprintServerInput,
    context: BlueprintsSmithyContext,
  ): Promise<DeleteBlueprintServerOutput> => {
    const { env } = context.lambdaContext;
    const blueprintStore = IsbServices.blueprintStore(env);
    const blueprintDeploymentService =
      IsbServices.blueprintDeploymentService(env);
    const leaseTemplateStore = IsbServices.leaseTemplateStore(env);

    const { blueprint } = await getBlueprintOr404(
      blueprintStore,
      input.blueprintId,
    );

    // A blueprint still referenced by a lease template throws `BlueprintInUseError`
    // (mapped to 409 by the shared error handler).
    await blueprintDeploymentService.unregisterBlueprint(
      { blueprint },
      blueprintStore,
      leaseTemplateStore,
    );

    logger.info("Blueprint unregistered successfully", {
      blueprintId: blueprint.blueprintId,
    });

    return {
      status: JSendStatus.SUCCESS,
      data: {
        message: "Blueprint unregistered successfully",
        blueprintId: blueprint.blueprintId,
      },
    };
  };
}

/**
 * The `BlueprintsApi` service. Every operation is wrapped in `withDelegatedErrors`
 * so the 400/404/409 business errors (including the service's `StackSetNotFoundError`
 * / `UnsupportedPermissionModelError` / `BlueprintInUseError`) render through the
 * shared Middy `httpErrorHandler` exactly as the pre-Smithy handler produced them.
 */
export function blueprintsService(
  logger: Logger,
): BlueprintsApiService<BlueprintsSmithyContext> {
  return {
    ListStackSets: withDelegatedErrors(listStackSets(logger)),
    ListBlueprints: withDelegatedErrors(listBlueprints(logger)),
    RegisterBlueprint: withDelegatedErrors(registerBlueprint(logger)),
    GetBlueprint: withDelegatedErrors(getBlueprint(logger)),
    UpdateBlueprint: withDelegatedErrors(updateBlueprint(logger)),
    DeleteBlueprint: withDelegatedErrors(deleteBlueprint(logger)),
  };
}
