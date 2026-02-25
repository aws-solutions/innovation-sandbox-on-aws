// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import { z } from "zod";

export const LogLevelSchema = z.enum(
  ["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL", "SILENT"],
  {
    errorMap: enumErrorMap,
  },
);

export const BaseLambdaEnvironmentSchema = z.object({
  NODE_OPTIONS: z.string(),
  USER_AGENT_EXTRA: z.string(),
  POWERTOOLS_LOG_LEVEL: LogLevelSchema,
  POWERTOOLS_SERVICE_NAME: z.string(),
  AWS_XRAY_CONTEXT_MISSING: z.literal("IGNORE_ERROR"),
});

export type BaseLambdaEnvironment = z.infer<typeof BaseLambdaEnvironmentSchema>;
