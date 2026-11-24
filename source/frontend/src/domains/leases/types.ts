// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RateBasis } from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

import type { LeaseView, MonitoredLeaseView, SharedLeaseView } from "./model";

export type {
  BedrockTokenHistoryData,
  BedrockTokenHistoryResponse,
  BreachAction,
  BreachEntry,
  BreachEvaluatedBy,
  BreachHistoryData,
  BreachHistoryResponse,
  BreachInsight,
  BreachTriggeredBy,
  CostHistoryCurrent,
  CostHistoryData,
  CostHistoryResponse,
  CostHistoryResultRow,
  CostSummaryData,
  CostSummaryResponse,
  CurrentServiceEntry,
  InsightKind,
  RateBasis,
  ServiceBreakdown,
  TokenSeriesRow,
  TokenType,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";

export type NewLeaseRequest = {
  leaseTemplateUuid: string;
  comments?: string;
  userEmail?: string;
  assignments?: AssignmentPrincipalRef[];
};

export type LeasePatchRequest = {
  leaseId: LeaseView["leaseId"];
  maxSpend?: MonitoredLeaseView["maxSpend"] | null;
  budgetThresholds?: MonitoredLeaseView["budgetThresholds"];
  expirationDate?: MonitoredLeaseView["expirationDate"] | null;
  durationThresholds?: MonitoredLeaseView["durationThresholds"];
  costReportGroup?: MonitoredLeaseView["costReportGroup"] | null;
  allowOwnerToShareLease?: boolean;
  rateLimits?: MonitoredLeaseView["rateLimits"] | null;
  predictiveBudgetEnabled?: boolean;
  bedrockTokenMonitoringEnabled?: boolean;
  sandboxSpacesEnabled?: MonitoredLeaseView["sandboxSpacesEnabled"];
  allowedModelIds?: MonitoredLeaseView["allowedModelIds"] | null;
  defaultModelId?: MonitoredLeaseView["defaultModelId"] | null;
  defaultPermissionSet?: PermissionSetReference;
  allowedPermissionSets?: PermissionSetReference[];
};

export type LeaseFormData = LeasePatchRequest & {
  maxBudgetEnabled?: boolean;
  maxDurationEnabled?: boolean;
};

// Identifier for one assignment tuple in a desired-state PUT body.
export type AssignmentPrincipalRef = {
  principalId: string;
  principalType: PrincipalType;
  permissionSetArn?: string;
};

export type SharedLeasesResponse = {
  result: SharedLeaseView[];
  nextPageIdentifier: string | null;
  error?: string;
};

// One page of the cost, Bedrock token or breach history.
export type CostHistoryPageOptions = {
  maxResults?: number;
  pageIdentifier?: string;
  // Bounds on row timestamps, as ISO 8601 instants: `afterTimestamp` inclusive,
  // `beforeTimestamp` exclusive. Either may stand alone: the API fills the
  // missing side with the lease's start (the epoch for an upper bound at or
  // before it) or now.
  afterTimestamp?: string;
  beforeTimestamp?: string;
};

export type CostHistoryRange = Pick<
  CostHistoryPageOptions,
  "afterTimestamp" | "beforeTimestamp"
>;

/**
 * One stretch of predicted spend on the spend chart, built from the readings. The
 * projection re-bases at every reading, so these are discrete segments rather
 * than one continuous series.
 */
export type PredictedSegment = {
  fromTimestamp: string;
  toTimestamp: string;
  startCost: number;
  endCost: number;
  rate: number;
  /**
   * Null on every segment but the current one: the basis in force at an
   * earlier reading is not stored, only the projection it produced.
   */
  rateSource?: RateBasis | null;
};
