// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { SES_IDENTITY_ARN_REGEX } from "@amzn/innovation-sandbox-shared/utils/ses-identity-arn.js";

export const SesIdentityEnvironmentShape = {
  SES_IDENTITY_ARN: z
    .string()
    .refine((value) => value === "" || SES_IDENTITY_ARN_REGEX.test(value), {
      message: "SES_IDENTITY_ARN must be empty or an SES identity ARN",
    }),
  AWS_REGION: z.string(),
} as const;

export function validateSesIdentityRegion(
  env: { SES_IDENTITY_ARN: string; AWS_REGION: string },
  context: z.RefinementCtx,
): void {
  if (env.SES_IDENTITY_ARN === "") {
    return;
  }
  const identityRegion = SES_IDENTITY_ARN_REGEX.exec(env.SES_IDENTITY_ARN)?.[1];
  if (identityRegion && identityRegion !== env.AWS_REGION) {
    context.addIssue({
      code: "custom",
      path: ["SES_IDENTITY_ARN"],
      message: "SES_IDENTITY_ARN Region must match AWS_REGION",
    });
  }
}
