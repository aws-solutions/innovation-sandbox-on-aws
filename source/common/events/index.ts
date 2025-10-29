// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const EventDetailTypes = {
  LeaseRequested: "LeaseRequested",
  LeaseApproved: "LeaseApproved",
  LeaseDenied: "LeaseDenied",
  LeaseBudgetThresholdBreachedAlert: "LeaseBudgetThresholdAlert",
  LeaseDurationThresholdBreachedAlert: "LeaseDurationThresholdAlert",
  LeaseFreezingThresholdBreachedAlert: "LeaseFreezingThresholdAlert",
  LeaseBudgetExceededAlert: "LeaseBudgetExceeded",
  LeaseExpiredAlert: "LeaseExpired",
  LeaseTerminated: "LeaseTerminated",
  LeaseFrozen: "LeaseFrozen",
  LeaseUnfrozen: "LeaseUnfrozen",
  CleanAccountRequest: "CleanAccountRequest",
  AccountCleanupSuccessful: "AccountCleanupSucceeded",
  AccountCleanupFailure: "AccountCleanupFailed",
  AccountQuarantined: "AccountQuarantined",
  AccountDriftDetected: "AccountDriftDetected",
  GroupCostReportGenerated: "GroupCostReportGenerated",
  GroupCostReportGeneratedFailure: "GroupCostReportGeneratedFailure",
} as const;
