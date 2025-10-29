// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const AuthSchema = z.object({
  idpSignInUrl: z
    .string()
    .nonempty(
      "Please refer back to InnovationSandbox's post-deployment configuration instructions",
    )
    .url()
    .describe("The IDP Sign In URL for IAM Identity Center SSO"),
  idpSignOutUrl: z
    .string()
    .nonempty(
      "Please refer back to InnovationSandbox's post-deployment configuration instructions",
    )
    .url()
    .describe("The IDP Sign Out URL for IAM Identity Center SSO"),
  idpAudience: z
    .string()
    .nonempty(
      "Please refer back to InnovationSandbox's post-deployment configuration instructions",
    )
    .describe("The IDP Audience Identifier for IAM Identity Center SSO"),
  awsAccessPortalUrl: z
    .string()
    .nonempty(
      "Please refer back to InnovationSandbox's post-deployment configuration instructions",
    )
    .url()
    .describe("The AWS Access Portal URL for IAM Identity Center SSO"),
  webAppUrl: z
    .string()
    .nonempty(
      "Please refer back to InnovationSandbox's post-deployment configuration instructions",
    )
    .url()
    .describe(
      "The URL of the application (defaults to Cloud Front Distribution URL)",
    ),
  sessionDurationInMinutes: z
    .number()
    .int()
    .gte(0)
    .describe("The duration of the session in minutes"),
});

export const GlobalConfigSchema = z.object({
  termsOfService: z
    .string()
    .describe(
      "The terms of service that must be agreed to before a lease can be requested",
    ),
  maintenanceMode: z
    .boolean()
    .describe("If enabled, the system will prevent the creation of new leases"),
  leases: z.object({
    requireMaxBudget: z
      .boolean()
      .describe("Whether or not to require a max budget on lease templates"),
    maxBudget: z
      .number()
      .int()
      .gte(0)
      .describe(
        "Maximum budget value (in dollars) that can be created on lease templates",
      ),
    requireMaxDuration: z
      .boolean()
      .describe("Whether or not to require a max duration on lease templates"),
    maxDurationHours: z
      .number()
      .int()
      .gte(0)
      .describe(
        "Maximum duration (in hours) that can be specified on a lease template",
      ),
    maxLeasesPerUser: z
      .number()
      .int()
      .gte(0)
      .describe(
        "The maximum number of active leases a user can have at any one time",
      ),
    ttl: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "The number of days the solution will store expired lease records before purging them from the database",
      ),
  }),
  cleanup: z.object({
    numberOfFailedAttemptsToCancelCleanup: z
      .number()
      .int()
      .gte(0)
      .describe("The number of failed attempts to cleanup before giving up"),
    waitBeforeRetryFailedAttemptSeconds: z
      .number()
      .int()
      .gte(0)
      .describe(
        "The number of seconds to wait before retrying a failed attempt to cleanup",
      ),
    numberOfSuccessfulAttemptsToFinishCleanup: z
      .number()
      .int()
      .gte(0)
      .describe("The number of successful attempts to finish cleanup"),
    waitBeforeRerunSuccessfulAttemptSeconds: z
      .number()
      .int()
      .gte(0)
      .describe(
        "The number of seconds to wait before rerunning a successful attempt",
      ),
  }),
  auth: AuthSchema,
  notification: z.object({
    emailFrom: z
      .union([z.string().email(), z.literal("")])
      .optional()
      .describe(
        "The email address to send notifications from. Leave empty or remove to disable email notifications",
      ),
  }),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const GlobalConfigForUISchema = GlobalConfigSchema.extend({
  isbManagedRegions: z
    .array(z.string())
    .nonempty()
    .describe("Isb Managed Regions"),
  auth: AuthSchema.omit({
    idpAudience: true,
    idpSignInUrl: true,
    idpSignOutUrl: true,
    sessionDurationInMinutes: true,
  }),
}).omit({
  notification: true,
});

export type GlobalConfigForUI = z.infer<typeof GlobalConfigForUISchema>;

export function getGlobalConfigForUI(
  globalConfig: GlobalConfig,
  regions: string[],
): GlobalConfigForUI {
  const { notification, auth, ...rest } = globalConfig;
  const {
    idpAudience,
    idpSignInUrl,
    idpSignOutUrl,
    sessionDurationInMinutes,
    ...restAuth
  } = auth;
  return {
    ...rest,
    auth: restAuth,
    isbManagedRegions: [regions[0]!, ...regions.slice(1)],
  };
}
