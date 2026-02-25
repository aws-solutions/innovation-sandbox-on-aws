// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CleanupReasonSchema } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { LeaseTerminatedReasonTypeSchema } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";
import z from "zod";

export const AccountDriftLogSchema = z.object({
  logDetailType: z.literal("AccountDrift"),
  accountId: AwsAccountIdSchema,
  expectedOu: z.string().optional(),
  actualOu: z.string().optional(),
});

export const LeasePublishedLogSchema = z.object({
  logDetailType: z.literal("LeasePublished"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
  maxBudget: z.number().optional(),
  maxDurationHours: z.number().optional(),
  autoApproved: z.boolean(),
  creationMethod: z.enum(["REQUESTED", "ASSIGNED"], {
    errorMap: enumErrorMap,
  }),
  hasBlueprint: z.boolean(),
});

export const LeaseTerminatedLogSchema = z.object({
  logDetailType: z.literal("LeaseTerminated"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
  startDate: z.string(),
  terminationDate: z.string(),
  maxBudget: z.number().optional(),
  actualSpend: z.number(),
  maxDurationHours: z.number().optional(),
  actualDurationHours: z.number(),
  reasonForTermination: LeaseTerminatedReasonTypeSchema,
});

export const LeaseUnfrozenLogSchema = z.object({
  logDetailType: z.literal("LeaseUnfrozen"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
});

export const LeaseResetLogSchema = z.object({
  logDetailType: z.literal("LeaseReset"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
  blueprintId: z.string().nullish(),
  blueprintName: z.string().optional(),
  reasonForReset: z.enum(["ProvisioningFailed"], {
    errorMap: enumErrorMap,
  }),
});

export const DeploymentSummaryLogSchema = z.object({
  logDetailType: z.literal("DeploymentSummary"),
  numLeaseTemplates: z.number().nonnegative(),
  numLeaseTemplatesWithBlueprint: z.number().nonnegative(),
  numBlueprints: z.number().nonnegative(),
  blueprintServiceCounts: z
    .record(z.string(), z.number().nonnegative())
    .optional(),
  config: z.object({
    numCostReportGroups: z.number().nonnegative(),
    requireMaxBudget: z.boolean(),
    maxBudget: z.number().nonnegative(),
    requireMaxDuration: z.boolean(),
    maxDurationHours: z.number().nonnegative(),
    maxLeasesPerUser: z.number().nonnegative(),
    requireCostReportGroup: z.boolean(),
    numberOfFailedAttemptsToCancelCleanup: z.number().nonnegative(),
    waitBeforeRetryFailedAttemptSeconds: z.number().nonnegative(),
    numberOfSuccessfulAttemptsToFinishCleanup: z.number().nonnegative(),
    waitBeforeRerunSuccessfulAttemptSeconds: z.number().nonnegative(),
    isStableTaggingEnabled: z.boolean(),
    isMultiAccountDeployment: z.boolean(),
  }),
  accountPool: z.object({
    available: z.number().nonnegative(),
    active: z.number().nonnegative(),
    frozen: z.number().nonnegative(),
    cleanup: z.number().nonnegative(),
    quarantine: z.number().nonnegative(),
  }),
});

export const CostReportingSchema = z.object({
  logDetailType: z.literal("CostReporting"),
  startDate: z.string(),
  endDate: z.string(),
  sandboxAccountsCost: z.number(),
  solutionOperatingCost: z.number(),
  numAccounts: z.number(),
});

export const AccountCleanupFailure = z.object({
  logDetailType: z.literal("AccountCleanupFailure"),
  accountId: AwsAccountIdSchema,
  durationMinutes: z.number(),
  stateMachineExecutionArn: z.string(),
  stateMachineExecutionURL: z.string(),
  reason: CleanupReasonSchema,
});

export const AccountCleanupSuccess = z.object({
  logDetailType: z.literal("AccountCleanupSuccess"),
  accountId: AwsAccountIdSchema,
  durationMinutes: z.number(),
  stateMachineExecutionArn: z.string(),
  stateMachineExecutionURL: z.string(),
  reason: CleanupReasonSchema,
});

export const SubscribableLogSchema = z.discriminatedUnion("logDetailType", [
  AccountDriftLogSchema,
  LeaseTerminatedLogSchema,
  LeasePublishedLogSchema,
  LeaseUnfrozenLogSchema,
  LeaseResetLogSchema,
  DeploymentSummaryLogSchema,
  CostReportingSchema,
  AccountCleanupFailure,
  AccountCleanupSuccess,
]);

export type SubscribableLog = z.infer<typeof SubscribableLogSchema>;
