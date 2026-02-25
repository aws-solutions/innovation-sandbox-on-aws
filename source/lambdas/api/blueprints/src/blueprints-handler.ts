// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { ConcurrencyMode } from "@aws-sdk/client-cloudformation";
import middy from "@middy/core";
import { type Route, default as httpRouterHandler } from "@middy/http-router";
import type { APIGatewayProxyResult } from "aws-lambda";
import { z } from "zod";

import {
  BlueprintItemSchema,
  StackSetItem,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  BlueprintLambdaEnvironment,
  BlueprintLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import apiMiddlewareBundle, {
  IsbApiContext,
  IsbApiEvent,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { httpJsonBodyParser } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-json-body-parser.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { createPaginationQueryStringParametersSchema } from "@amzn/innovation-sandbox-commons/lambda/schemas.js";
import {
  addCorrelationContext,
  searchableBlueprintProperties,
  summarizeUpdate,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";

const tracer = new Tracer();
const logger = new Logger();

const middyFactory = middy<
  IsbApiEvent,
  APIGatewayProxyResult,
  Error,
  ContextWithConfig & IsbApiContext<BlueprintLambdaEnvironment>
>;

function getBlueprintIdFromPath(
  pathParameters?: Record<string, string | undefined>,
): string {
  const PathParametersSchema = z.object({
    blueprintId: z.string().uuid(),
  });

  const result = PathParametersSchema.safeParse(pathParameters);

  if (!result.success) {
    throw createHttpJSendValidationError(result.error);
  }

  return result.data.blueprintId;
}

const routes: Route<IsbApiEvent, APIGatewayProxyResult>[] = [
  {
    path: "/blueprints/stacksets",
    method: "GET",
    handler: middyFactory().handler(listStackSetsHandler),
  },
  {
    path: "/blueprints",
    method: "GET",
    handler: middyFactory().handler(getBlueprintsHandler),
  },
  {
    path: "/blueprints",
    method: "POST",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(registerBlueprintHandler),
  },
  {
    path: "/blueprints/{blueprintId}",
    method: "GET",
    handler: middyFactory().handler(getBlueprintHandler),
  },
  {
    path: "/blueprints/{blueprintId}",
    method: "PUT",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(updateBlueprintHandler),
  },
  {
    path: "/blueprints/{blueprintId}",
    method: "DELETE",
    handler: middyFactory().handler(unregisterBlueprintHandler),
  },
];

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: BlueprintLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .handler(httpRouterHandler(routes));

async function listStackSetsHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<BlueprintLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const parsedPaginationParametersResult =
    createPaginationQueryStringParametersSchema({ maxPageSize: 100 }).safeParse(
      event.queryStringParameters,
    );

  if (!parsedPaginationParametersResult.success) {
    throw createHttpJSendValidationError(
      parsedPaginationParametersResult.error,
    );
  }

  const { pageIdentifier, pageSize } = parsedPaginationParametersResult.data;

  const blueprintDeploymentService = IsbServices.blueprintDeploymentService(
    context.env,
  );

  const response = await blueprintDeploymentService.listStackSets({
    pageIdentifier,
    pageSize,
  });

  logger.info("StackSets retrieved for blueprint registration", {
    count: response.stackSets.length,
    hasNextPageIdentifier: !!response.nextPageIdentifier,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        result: response.stackSets.map((stackSet) => ({
          stackSetName: stackSet.StackSetName,
          stackSetId: stackSet.StackSetId,
          description: stackSet.Description,
          status: stackSet.Status,
          permissionModel: stackSet.PermissionModel,
        })),
        nextPageIdentifier: response.nextPageIdentifier,
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function getBlueprintsHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<BlueprintLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const parsedPaginationParametersResult =
    createPaginationQueryStringParametersSchema({
      maxPageSize: 100,
    }).safeParse(event.queryStringParameters);

  if (!parsedPaginationParametersResult.success) {
    throw createHttpJSendValidationError(
      parsedPaginationParametersResult.error,
    );
  }

  const { pageIdentifier, pageSize } = parsedPaginationParametersResult.data;

  const blueprintStore = IsbServices.blueprintStore(context.env);

  const blueprints = await blueprintStore.listBlueprints({
    pageIdentifier,
    pageSize,
  });

  logger.info("Blueprints retrieved", {
    count: blueprints.result.length,
    hasNextPageIdentifier: !!blueprints.nextPageIdentifier,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        blueprints: blueprints.result,
        nextPageIdentifier: blueprints.nextPageIdentifier,
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function registerBlueprintHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<BlueprintLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const requestSchema = BlueprintItemSchema.omit({
    PK: true,
    SK: true,
    itemType: true,
    blueprintId: true,
    createdBy: true,
    meta: true,
    totalHealthMetrics: true,
  }).extend({
    stackSetId: z.string().min(1),
    regions: z.array(z.string()).min(1),
    maxConcurrentPercentage: z.number().int().min(1).max(100).optional(),
    failureTolerancePercentage: z.number().int().min(0).max(100).optional(),
    concurrencyMode: z
      .enum(
        [
          ConcurrencyMode.STRICT_FAILURE_TOLERANCE,
          ConcurrencyMode.SOFT_FAILURE_TOLERANCE,
        ],
        {
          errorMap: enumErrorMap,
        },
      )
      .optional(),
  });

  const parsedBodyResult = requestSchema.safeParse(event.body);

  if (!parsedBodyResult.success) {
    throw createHttpJSendValidationError(parsedBodyResult.error);
  }

  const userEmail = context.user.email;

  const blueprintStore = IsbServices.blueprintStore(context.env);
  const blueprintDeploymentService = IsbServices.blueprintDeploymentService(
    context.env,
  );

  const blueprint = await blueprintDeploymentService.registerBlueprint(
    {
      name: parsedBodyResult.data.name,
      stackSetId: parsedBodyResult.data.stackSetId,
      regions: parsedBodyResult.data.regions,
      tags: parsedBodyResult.data.tags,
      deploymentTimeoutMinutes: parsedBodyResult.data.deploymentTimeoutMinutes,
      regionConcurrencyType: parsedBodyResult.data.regionConcurrencyType,
      maxConcurrentPercentage: parsedBodyResult.data.maxConcurrentPercentage,
      failureTolerancePercentage:
        parsedBodyResult.data.failureTolerancePercentage,
      concurrencyMode: parsedBodyResult.data.concurrencyMode,
      createdBy: userEmail,
    },
    blueprintStore,
  );

  addCorrelationContext(
    logger,
    searchableBlueprintProperties({
      blueprint,
      stackSets: [],
    }),
  );

  logger.info(
    `Created new Blueprint (${blueprint.name}) (${blueprint.blueprintId})`,
  );

  return {
    statusCode: 201,
    body: JSON.stringify({
      status: "success",
      data: blueprint,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function getBlueprintHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<BlueprintLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const blueprintId = getBlueprintIdFromPath(event.pathParameters);

  const blueprintStore = IsbServices.blueprintStore(context.env);

  const blueprintResult = await blueprintStore.get(blueprintId);

  if (!blueprintResult.result) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: "Blueprint not found",
          },
        ],
      },
    });
  }

  const blueprintWithStackSets = blueprintResult.result;

  logger.info("Blueprint retrieved", {
    blueprintId: blueprintWithStackSets.blueprint.blueprintId,
    name: blueprintWithStackSets.blueprint.name,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: blueprintWithStackSets,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function updateBlueprintHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<BlueprintLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const blueprintId = getBlueprintIdFromPath(event.pathParameters);

  const updateSchema = BlueprintItemSchema.pick({
    name: true,
    tags: true,
    deploymentTimeoutMinutes: true,
    regionConcurrencyType: true,
  })
    .partial()
    .extend({
      // StackSet-level parameters (stored in StackSetItem)
      maxConcurrentPercentage: z.number().int().min(1).max(100).optional(),
      failureTolerancePercentage: z.number().int().min(0).max(100).optional(),
      concurrencyMode: z
        .enum([
          ConcurrencyMode.STRICT_FAILURE_TOLERANCE,
          ConcurrencyMode.SOFT_FAILURE_TOLERANCE,
        ])
        .optional(),
    });

  const parsedBodyResult = updateSchema.safeParse(event.body);

  if (!parsedBodyResult.success) {
    throw createHttpJSendValidationError(parsedBodyResult.error);
  }

  const blueprintStore = IsbServices.blueprintStore(context.env);

  const blueprintResult = await blueprintStore.get(blueprintId);

  if (!blueprintResult.result) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: "Blueprint not found",
          },
        ],
      },
    });
  }

  const blueprintWithStackSets = blueprintResult.result;
  const blueprint = blueprintWithStackSets.blueprint;
  const stackSets = blueprintWithStackSets.stackSets;

  // Separate BlueprintItem fields from StackSetItem fields
  const {
    maxConcurrentPercentage,
    failureTolerancePercentage,
    concurrencyMode,
    ...blueprintFields
  } = parsedBodyResult.data;

  // Check if StackSet fields need updating
  const hasStackSetUpdates =
    maxConcurrentPercentage !== undefined ||
    failureTolerancePercentage !== undefined ||
    concurrencyMode !== undefined;

  let updatedBlueprintWithStackSets;

  if (hasStackSetUpdates && stackSets.length > 0) {
    // Update both BlueprintItem and StackSetItem atomically
    const updatedBlueprint = {
      ...blueprint,
      ...blueprintFields,
    };

    const stackSet = stackSets[0]; // Current release: single StackSet
    const updatedStackSet: StackSetItem = {
      ...stackSet,
      ...(maxConcurrentPercentage !== undefined && {
        maxConcurrentPercentage,
      }),
      ...(failureTolerancePercentage !== undefined && {
        failureTolerancePercentage,
      }),
      ...(concurrencyMode !== undefined && {
        concurrencyMode,
      }),
    } as StackSetItem;

    // Atomic update returns complete composite - use it directly
    updatedBlueprintWithStackSets =
      await blueprintStore.updateBlueprintWithStackSet(
        updatedBlueprint,
        updatedStackSet,
      );

    logger.info("Blueprint updated successfully", {
      blueprintId: blueprint.blueprintId,
      updatedFields: Object.keys(parsedBodyResult.data),
    });
  } else {
    // Update only BlueprintItem fields
    const updatedBlueprint = {
      ...blueprint,
      ...blueprintFields,
    };

    const updateResult = await blueprintStore.update(updatedBlueprint);

    // Fetch complete composite for response
    const fetchResult = await blueprintStore.get(blueprintId);
    updatedBlueprintWithStackSets = fetchResult.result;

    // Use summarizeUpdate for consistent logging with diff
    logger.info("Blueprint updated successfully", {
      blueprintId: blueprint.blueprintId,
      ...summarizeUpdate({
        oldItem: updateResult.oldItem,
        newItem: updateResult.newItem,
      }),
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: updatedBlueprintWithStackSets,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function unregisterBlueprintHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<BlueprintLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const blueprintId = getBlueprintIdFromPath(event.pathParameters);

  const blueprintStore = IsbServices.blueprintStore(context.env);
  const blueprintDeploymentService = IsbServices.blueprintDeploymentService(
    context.env,
  );
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  const blueprintResult = await blueprintStore.get(blueprintId);

  if (!blueprintResult.result) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: "Blueprint not found",
          },
        ],
      },
    });
  }

  const blueprintWithStackSets = blueprintResult.result;

  await blueprintDeploymentService.unregisterBlueprint(
    { blueprint: blueprintWithStackSets.blueprint },
    blueprintStore,
    leaseTemplateStore,
  );

  logger.info("Blueprint unregistered successfully", {
    blueprintId: blueprintWithStackSets.blueprint.blueprintId,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        message: "Blueprint unregistered successfully",
        blueprintId: blueprintWithStackSets.blueprint.blueprintId,
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}
