// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const BlueprintDeploymentOrchestratorEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    ISB_EVENT_BUS: z.string(),
    ISB_NAMESPACE: z.string(),
    LEASE_TABLE_NAME: z.string(),
    BLUEPRINT_TABLE_NAME: z.string(),
    BLUEPRINT_DEPLOYMENT_STATE_MACHINE_ARN: z.string().optional(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    SANDBOX_ACCOUNT_ROLE_NAME: z.string(),
    ORG_MGT_ACCOUNT_ID: z.string(),
    HUB_ACCOUNT_ID: z.string(),
  });

export type BlueprintDeploymentOrchestratorEnvironment = z.infer<
  typeof BlueprintDeploymentOrchestratorEnvironmentSchema
>;
