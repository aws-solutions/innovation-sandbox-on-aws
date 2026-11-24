// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

/**
 * Deliberately carries no cross-account role ARNs. The poll reads Bedrock
 * token metrics in the hub through CloudWatch cross-account observability with
 * its own execution role, so it assumes nothing and holds no credential chain.
 */
export const TokenPollEnvironmentSchema = BaseLambdaEnvironmentSchema.extend({
  ISB_EVENT_BUS: z.string(),
  CONFIG_TABLE_NAME: z.string(),
  LEASE_TABLE_NAME: z.string(),
  LEASE_COST_HISTORY_TABLE_NAME: z.string(),
  BEDROCK_REGIONAL_PRICE_TABLE_NAME: z.string(),
  ISB_NAMESPACE: z.string(),
  ACCOUNT_POOL_CONFIG_PARAM_ARN: z.string(),
  /**
   * The sink custom resource's region-to-sink-id map, `{"<region>":{"Id":"<sink id>"}}`,
   * passed through as is. The poll builds each region's sink ARN from the key,
   * the id and its own partition and account.
   */
  OAM_SINK_IDS_JSON: z.string(),
  /** Minutes between scheduled runs, as the schedule sets them. */
  TOKEN_POLL_INTERVAL_MINUTES: z.string().regex(/^[1-9]\d*$/),
});

export type TokenPollEnvironment = z.infer<typeof TokenPollEnvironmentSchema>;
