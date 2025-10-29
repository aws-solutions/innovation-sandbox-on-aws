// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import middy from "@middy/core";
import { type Route, default as httpRouterHandler } from "@middy/http-router";
import type { APIGatewayProxyResult } from "aws-lambda";

import { UnknownItem } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  validateLeaseTemplateCompliesWithGlobalConfig,
  ValidationException,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { LeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { validateCostReportGroup } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config-utils.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  LeaseTemplateLambdaEnvironment,
  LeaseTemplateLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
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
  ContextWithGlobalAndReportingConfig,
  isbConfigMiddleware,
  isbReportingConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { createPaginationQueryStringParametersSchema } from "@amzn/innovation-sandbox-commons/lambda/schemas.js";
import {
  addCorrelationContext,
  AppInsightsLogPatterns,
  searchableLeaseTemplateProperties,
  summarizeUpdate,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  IsbRole,
  IsbUser,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { randomUUID } from "crypto";

const tracer = new Tracer();
const logger = new Logger();

const middyFactory = middy<
  IsbApiEvent,
  any,
  Error,
  ContextWithGlobalAndReportingConfig &
    IsbApiContext<LeaseTemplateLambdaEnvironment>
>;

const routes: Route<IsbApiEvent, APIGatewayProxyResult>[] = [
  {
    path: "/leaseTemplates",
    method: "GET",
    handler: middyFactory().handler(getLeaseTemplatesHandler),
  },
  {
    path: "/leaseTemplates",
    method: "POST",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(postLeaseTemplatesHandler),
  },
  {
    path: "/leaseTemplates/{leaseTemplateId}",
    method: "GET",
    handler: middyFactory().handler(getLeaseTemplateByIdHandler),
  },
  {
    path: "/leaseTemplates/{leaseTemplateId}",
    method: "PUT",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(putLeaseTemplateByIdHandler),
  },
  {
    path: "/leaseTemplates/{leaseTemplateId}",
    method: "DELETE",
    handler: middyFactory().handler(deleteLeaseTemplateByIdHandler),
  },
];

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: LeaseTemplateLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .use(isbReportingConfigMiddleware())
  .handler(httpRouterHandler(routes));

async function getLeaseTemplatesHandler(
  event: IsbApiEvent,
  context: ContextWithGlobalAndReportingConfig &
    IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  const parsedPaginationParametersResult =
    createPaginationQueryStringParametersSchema({
      maxPageSize: 2000,
    }).safeParse(event.queryStringParameters);

  if (!parsedPaginationParametersResult.success) {
    throw createHttpJSendValidationError(
      parsedPaginationParametersResult.error,
    );
  }

  const { pageIdentifier, pageSize } = parsedPaginationParametersResult.data;

  const queryResult = await leaseTemplateStore.findAll({
    pageIdentifier,
    pageSize,
  });

  if (queryResult.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error while fetching lease templates - ${queryResult.error}`,
    );
  }

  // Filter out private templates for users without elevated permissions
  if (!authorizedToGetPrivateLeaseTemplates(context.user)) {
    queryResult.result = queryResult.result.filter(
      (template) => template.visibility !== "PRIVATE",
    );
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: queryResult,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function postLeaseTemplatesHandler(
  event: IsbApiEvent,
  context: ContextWithGlobalAndReportingConfig &
    IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  const parsedBodyResult = LeaseTemplateSchema.omit({
    uuid: true,
    createdBy: true,
  }).safeParse(event.body);

  if (!parsedBodyResult.success) {
    throw createHttpJSendValidationError(parsedBodyResult.error);
  }

  try {
    validateLeaseTemplateCompliesWithGlobalConfig(
      parsedBodyResult.data,
      context.globalConfig,
    );
    validateCostReportGroup(
      parsedBodyResult.data.costReportGroup,
      context.reportingConfig,
    );
  } catch (error) {
    if (error instanceof ValidationException) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            {
              message: error.message,
            },
          ],
        },
      });
    } else {
      throw error;
    }
  }

  const newLeaseTemplate = await leaseTemplateStore.create({
    uuid: randomUUID(),
    createdBy: context.user.email,
    ...parsedBodyResult.data,
  });

  addCorrelationContext(
    logger,
    searchableLeaseTemplateProperties(newLeaseTemplate),
  );

  logger.info(
    `Created new LeaseTemplate (${newLeaseTemplate.name}) (${newLeaseTemplate.uuid})`,
    summarizeUpdate({
      oldItem: undefined,
      newItem: newLeaseTemplate,
    }),
  );

  return {
    statusCode: 201,
    body: JSON.stringify({
      status: "success",
      data: newLeaseTemplate,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function getLeaseTemplateByIdHandler(
  event: IsbApiEvent,
  context: ContextWithGlobalAndReportingConfig &
    IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  if (event.pathParameters.leaseTemplateId === undefined) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [{ message: "{leaseTemplateId} path parameter is required." }],
      },
    });
  }

  const leaseTemplateResponse = await leaseTemplateStore.get(
    event.pathParameters.leaseTemplateId,
  );
  const leaseTemplate = leaseTemplateResponse.result;
  if (leaseTemplateResponse.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error retrieving lease template ${event.pathParameters.leaseTemplateId}: ${leaseTemplateResponse.error}`,
    );
  }

  if (
    !leaseTemplate ||
    (leaseTemplate.visibility === "PRIVATE" &&
      !authorizedToGetPrivateLeaseTemplates(context.user))
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

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: leaseTemplate,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function putLeaseTemplateByIdHandler(
  event: IsbApiEvent,
  context: ContextWithGlobalAndReportingConfig &
    IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  if (event.pathParameters.leaseTemplateId == null) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [{ message: "{leaseTemplateId} path parameter is required." }],
      },
    });
  }

  const parsedBodyResult = LeaseTemplateSchema.omit({ uuid: true }).safeParse(
    event.body,
  );

  if (!parsedBodyResult.success) {
    throw createHttpJSendValidationError(parsedBodyResult.error);
  }

  try {
    validateLeaseTemplateCompliesWithGlobalConfig(
      parsedBodyResult.data,
      context.globalConfig,
    );
    validateCostReportGroup(
      parsedBodyResult.data.costReportGroup,
      context.reportingConfig,
    );
  } catch (error) {
    if (error instanceof ValidationException) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            {
              message: error.message,
            },
          ],
        },
      });
    } else {
      throw error;
    }
  }

  const leaseTemplate = {
    uuid: event.pathParameters.leaseTemplateId,
    ...parsedBodyResult.data,
  };

  try {
    const result = await leaseTemplateStore.update(leaseTemplate);

    logger.info(
      `Updated LeaseTemplate (${leaseTemplate.name})(${leaseTemplate.uuid})`,
      summarizeUpdate(result),
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        data: result.newItem,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    if (error instanceof UnknownItem) {
      throw createHttpJSendError({
        statusCode: 404,
        data: {
          errors: [
            {
              message: `Lease Template not found.`,
            },
          ],
        },
      });
    } else {
      throw error;
    }
  }
}

async function deleteLeaseTemplateByIdHandler(
  event: IsbApiEvent,
  context: ContextWithGlobalAndReportingConfig &
    IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  if (event.pathParameters.leaseTemplateId === undefined) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [{ message: "{leaseTemplateId} path parameter is required." }],
      },
    });
  }

  const itemId = event.pathParameters.leaseTemplateId;
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

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: null,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

function authorizedToGetPrivateLeaseTemplates(user: IsbUser) {
  return (
    user.roles?.some(
      (role: IsbRole) => role === "Admin" || role === "Manager",
    ) ?? false
  );
}
