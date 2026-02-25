// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { z } from "zod";

import {
  BlueprintDeploymentOrchestratorEnvironment,
  BlueprintDeploymentOrchestratorEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-deployment-orchestrator-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";

import {
  CheckStatusActionInputSchema,
  handleCheckStatus,
} from "@amzn/innovation-sandbox-blueprint-deployment-orchestrator/actions/check-deployment-status.js";
import {
  CreateActionInputSchema,
  handleCreateStackInstances,
} from "@amzn/innovation-sandbox-blueprint-deployment-orchestrator/actions/create-stack-instances.js";
import {
  PublishResultActionInputSchema,
  handlePublishResult,
} from "@amzn/innovation-sandbox-blueprint-deployment-orchestrator/actions/publish-deployment-result.js";

const serviceName = "BlueprintDeploymentOrchestrator";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

const DeploymentOrchestratorInputSchema = z.discriminatedUnion("action", [
  CreateActionInputSchema,
  CheckStatusActionInputSchema,
  PublishResultActionInputSchema,
]);

type DeploymentOrchestratorInput = z.infer<
  typeof DeploymentOrchestratorInputSchema
>;
type OrchestratorContext =
  IsbLambdaContext<BlueprintDeploymentOrchestratorEnvironment>;

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: BlueprintDeploymentOrchestratorEnvironmentSchema,
  moduleName: "blueprint-deployment-orchestrator",
}).handler(handleDeploymentOrchestrator);

async function handleDeploymentOrchestrator(
  event: DeploymentOrchestratorInput,
  context: OrchestratorContext,
) {
  const validatedEvent = DeploymentOrchestratorInputSchema.parse(event);

  logger.info("Processing deployment orchestrator action", {
    action: validatedEvent.action,
  });

  switch (validatedEvent.action) {
    case "CREATE":
      return await handleCreateStackInstances(
        validatedEvent,
        context.env,
        logger,
      );
    case "CHECK_STATUS":
      return await handleCheckStatus(validatedEvent, context.env, logger);
    case "PUBLISH_RESULT":
      return await handlePublishResult(
        validatedEvent,
        context.env,
        logger,
        tracer,
      );
    default:
      assertNever(validatedEvent);
  }
}
