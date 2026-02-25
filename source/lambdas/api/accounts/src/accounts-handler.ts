// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import middy from "@middy/core";
import httpRouterHandler, { Route } from "@middy/http-router";
import {
  APIGatewayProxyEventPathParameters,
  APIGatewayProxyResult,
} from "aws-lambda";

import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import {
  AccountInCleanUpError,
  AccountNotInQuarantineError,
  InnovationSandbox,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  AccountLambdaEnvironment,
  AccountLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
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
import { AppInsightsLogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const tracer = new Tracer();
const logger = new Logger();

const middyFactory = middy<IsbApiEvent, any, Error, AccountsApiContext>;

const routes: Route<IsbApiEvent, APIGatewayProxyResult>[] = [
  {
    path: "/accounts",
    method: "GET",
    handler: middyFactory().handler(findAccountsHandler),
  },
  {
    path: "/accounts",
    method: "POST",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(postAccountHandler),
  },
  {
    path: "/accounts/{awsAccountId}",
    method: "GET",
    handler: middyFactory().handler(getAccountHandler),
  },
  {
    path: "/accounts/{awsAccountId}/retryCleanup",
    method: "POST",
    handler: middyFactory().handler(retryCleanupHandler),
  },
  {
    path: "/accounts/{awsAccountId}/eject",
    method: "POST",
    handler: middyFactory().handler(ejectAccountHandler),
  },
  {
    path: "/accounts/unregistered",
    method: "GET",
    handler: middyFactory().handler(findUnregisteredAccountsHandler),
  },
];

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: AccountLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .handler(httpRouterHandler(routes));

type AccountsApiContext = ContextWithConfig &
  IsbApiContext<AccountLambdaEnvironment>;

async function findAccountsHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const accountStore = IsbServices.sandboxAccountStore(context.env);

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

  const queryResult = await accountStore.findAll({ pageIdentifier, pageSize });
  if (queryResult.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error while fetching accounts: ${queryResult.error}`,
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

async function postAccountHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const accountParseResponse = SandboxAccountSchema.omit({
    cleanupExecutionContext: true,
    status: true,
    driftAtLastScan: true,
  })
    .strict()
    .safeParse(event.body);

  if (!accountParseResponse.success) {
    throw createHttpJSendValidationError(accountParseResponse.error);
  }

  const { ORG_MGT_ACCOUNT_ID, IDC_ACCOUNT_ID, HUB_ACCOUNT_ID } = context.env;
  if (
    [ORG_MGT_ACCOUNT_ID, IDC_ACCOUNT_ID, HUB_ACCOUNT_ID].includes(
      accountParseResponse.data.awsAccountId,
    )
  ) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            message: `Account is an ISB administration account. Aborting registration.`,
          },
        ],
      },
    });
  }

  const isbContext = {
    logger,
    tracer,
    eventBridgeClient: IsbServices.isbEventBridge(context.env),
    orgsService: IsbServices.orgsService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    idcService: IsbServices.idcService(
      context.env,
      fromTemporaryIsbIdcCredentials(context.env),
    ),
  };

  const result = await InnovationSandbox.registerAccount(
    accountParseResponse.data.awsAccountId,
    isbContext,
  );

  return {
    statusCode: 201,
    body: JSON.stringify({
      status: "success",
      data: result,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function getAccountHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const awsAccountId = parseAwsAccountIdFromPathParameters(
    event.pathParameters,
  );
  const accountStore = IsbServices.sandboxAccountStore(context.env);
  const accountResponse = await accountStore.get(awsAccountId);
  const account = accountResponse.result;
  if (accountResponse.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error in retrieving account ${awsAccountId}: ${accountResponse.error}`,
    );
  }
  if (!account) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: `Account not found.`,
          },
        ],
      },
    });
  }
  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: account,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function ejectAccountHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
) {
  const awsAccountId = parseAwsAccountIdFromPathParameters(
    event.pathParameters,
  );

  const accountStore = IsbServices.sandboxAccountStore(context.env);
  const accountResponse = await accountStore.get(awsAccountId);
  const account = accountResponse.result;
  if (accountResponse.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error in retrieving account ${awsAccountId}: ${accountResponse.error}`,
    );
  }

  if (!account) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: `Account not found.`,
          },
        ],
      },
    });
  }

  try {
    await InnovationSandbox.ejectAccount(
      {
        sandboxAccount: account,
      },
      {
        logger,
        tracer,
        sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
        leaseStore: IsbServices.leaseStore(context.env),
        orgsService: IsbServices.orgsService(
          context.env,
          fromTemporaryIsbOrgManagementCredentials(context.env),
        ),
        idcService: IsbServices.idcService(
          context.env,
          fromTemporaryIsbIdcCredentials(context.env),
        ),
        eventBridgeClient: IsbServices.isbEventBridge(context.env),
        globalConfig: context.globalConfig,
        blueprintStore: IsbServices.blueprintStore(context.env),
        blueprintDeploymentService: IsbServices.blueprintDeploymentService(
          context.env,
        ),
      },
    );
  } catch (error) {
    if (error instanceof AccountInCleanUpError) {
      throw createHttpJSendError({
        statusCode: 409,
        data: { errors: [{ message: error.message }] },
      });
    } else {
      throw error;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function retryCleanupHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const awsAccountId = parseAwsAccountIdFromPathParameters(
    event.pathParameters,
  );

  const accountStore = IsbServices.sandboxAccountStore(context.env);
  const accountResponse = await accountStore.get(awsAccountId);
  const account = accountResponse.result;
  if (accountResponse.error) {
    logger.warn(
      `${AppInsightsLogPatterns.DataValidationWarning.pattern}: Error retrieving account ${awsAccountId}: ${accountResponse.error}`,
    );
  }

  if (!account) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: `Account not found.`,
          },
        ],
      },
    });
  }

  try {
    await InnovationSandbox.retryCleanup(
      {
        sandboxAccount: account,
      },
      {
        logger,
        tracer,
        eventBridgeClient: IsbServices.isbEventBridge(context.env),
        orgsService: IsbServices.orgsService(
          context.env,
          fromTemporaryIsbOrgManagementCredentials(context.env),
        ),
        sandboxAccountStore: accountStore,
      },
    );
  } catch (error) {
    if (error instanceof AccountNotInQuarantineError) {
      throw createHttpJSendError({
        statusCode: 409,
        data: { errors: [{ message: error.message }] },
      });
    } else {
      throw error;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function findUnregisteredAccountsHandler(
  event: IsbApiEvent,
  context: AccountsApiContext,
): Promise<APIGatewayProxyResult> {
  const parsedPaginationParametersResult =
    createPaginationQueryStringParametersSchema({ maxPageSize: 20 }).safeParse(
      event.queryStringParameters,
    );

  if (!parsedPaginationParametersResult.success) {
    throw createHttpJSendValidationError(
      parsedPaginationParametersResult.error,
    );
  }

  const { pageIdentifier, pageSize } = parsedPaginationParametersResult.data;

  const orgService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );

  const unregisteredAccounts = await orgService.listAccountsInOU({
    ouName: "Entry",
    pageIdentifier,
    pageSize,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        result:
          unregisteredAccounts.accounts?.map((account) => ({
            Id: account.Id,
            Email: account.Email,
            Name: account.Name,
          })) ?? [],
        nextPageIdentifier: unregisteredAccounts.nextPageIdentifier,
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

function parseAwsAccountIdFromPathParameters(
  pathParameters: APIGatewayProxyEventPathParameters,
) {
  const PathParametersSchema = SandboxAccountSchema.pick({
    awsAccountId: true,
  });
  const parsedPathParametersResponse =
    PathParametersSchema.safeParse(pathParameters);
  if (!parsedPathParametersResponse.success) {
    throw createHttpJSendValidationError(parsedPathParametersResponse.error);
  }
  return parsedPathParametersResponse.data.awsAccountId;
}
