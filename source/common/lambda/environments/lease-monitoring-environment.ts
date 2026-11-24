// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const LeaseMonitoringEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    ISB_EVENT_BUS: z.string(),
    CONFIG_TABLE_NAME: z.string(),
    LEASE_TABLE_NAME: z.string(),
    LEASE_COST_HISTORY_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
  });

export type LeaseMonitoringEnvironment = z.infer<
  typeof LeaseMonitoringEnvironmentSchema
>;
