// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  InitializeCleanupLambdaEnvironment,
  InitializeCleanupLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/initialize-cleanup-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { DescribeExecutionCommand } from "@aws-sdk/client-sfn";

const serviceName = "InitializeCleanup";
const tracer = new Tracer();
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: InitializeCleanupLambdaEnvironmentSchema,
  moduleName: "initialize-cleanup",
})
  .use(isbConfigMiddleware())
  .handler(initializeCleanupHandler);

export type InitializeCleanupLambdaEvent = {
  cleanupExecutionContext: {
    stateMachineExecutionArn: string;
    stateMachineExecutionStartTime: string;
  };
  accountId: string;
};

async function initializeCleanupHandler(
  event: InitializeCleanupLambdaEvent,
  context: ContextWithConfig &
    ValidatedEnvironment<InitializeCleanupLambdaEnvironment>,
) {
  logger.info(`Initialize cleanup for account ${event.accountId}`);

  const { ORG_MGT_ACCOUNT_ID, IDC_ACCOUNT_ID, HUB_ACCOUNT_ID } = context.env;
  if (
    [ORG_MGT_ACCOUNT_ID, IDC_ACCOUNT_ID, HUB_ACCOUNT_ID].includes(
      event.accountId,
    )
  ) {
    const errorMessage = `Account ${event.accountId} is an ISB administration account. Aborting cleanup.`;
    logger.error(errorMessage);
    throw Error(errorMessage);
  }

  const accountStore = IsbServices.sandboxAccountStore(context.env);
  const accountResponse = await accountStore.get(event.accountId);
  const account = accountResponse.result;
  if (accountResponse.error) {
    logger.warn(
      `Error in retrieving account ${event.accountId}: ${accountResponse.error}`,
    );
  }

  if (!account) {
    throw Error("Unable to find account.");
  }

  if (
    account.cleanupExecutionContext?.stateMachineExecutionArn &&
    (await stepFunctionIsStillRunning(
      account.cleanupExecutionContext.stateMachineExecutionArn,
      context.env,
    ))
  ) {
    logger.info(
      `Cleanup for account ${event.accountId} already has an inprogress stateMachineExecution ${event.cleanupExecutionContext.stateMachineExecutionArn} that started at ${event.cleanupExecutionContext.stateMachineExecutionStartTime}`,
    );
    return { cleanupAlreadyInProgress: true };
  }

  await accountStore.put({
    ...account,
    cleanupExecutionContext: {
      stateMachineExecutionArn:
        event.cleanupExecutionContext.stateMachineExecutionArn,
      stateMachineExecutionStartTime:
        event.cleanupExecutionContext.stateMachineExecutionStartTime,
    },
  });

  return {
    cleanupAlreadyInProgress: false,
    globalConfig: context.globalConfig,
  };
}

async function stepFunctionIsStillRunning(
  executionArn: string,
  env: {
    USER_AGENT_EXTRA: string;
  },
): Promise<boolean> {
  const sfnClient = IsbClients.stepFunctions(env);

  try {
    const response = await sfnClient.send(
      new DescribeExecutionCommand({
        executionArn: executionArn,
      }),
    );

    // Step Functions execution status can be RUNNING, SUCCEEDED, FAILED, TIMED_OUT, or ABORTED
    return response.status === "RUNNING";
  } catch (error) {
    // If execution doesn't exist (e.g., history deleted after 90 days),
    // treat it as not running so cleanup can proceed
    if (error instanceof Error && error.name === "ExecutionDoesNotExist") {
      logger.info(
        `Step Function execution ${executionArn} no longer exists (likely due to history retention), treating as not running`,
      );
      return false;
    }

    // Re-throw other errors as they indicate actual problems
    throw error;
  }
}
