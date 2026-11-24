// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import {
  SesIdentityEnvironmentShape,
  validateSesIdentityRegion,
} from "@amzn/innovation-sandbox-commons/lambda/environments/ses-identity-environment.js";

export const EmailNotificationEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    ISB_EVENT_BUS: z.string(),
    CONFIG_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
    WEB_APP_URL: z.string(),
    ...SesIdentityEnvironmentShape,
    SNS_INTEGRATION_TOPIC_ARN: z.string(),
  }).superRefine(validateSesIdentityRegion);

export type EmailNotificationEnvironment = z.infer<
  typeof EmailNotificationEnvironmentSchema
>;
