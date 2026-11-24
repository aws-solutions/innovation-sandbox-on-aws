// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { PersistedBlueprintWithStackSets } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { PersistedSandboxAccount } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { IsbAccountTagSuffix } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";
import {
  isMonitoredLease,
  type Lease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { ConstraintViolationException } from "@aws-sdk/client-organizations";
import { diff, IChange } from "json-diff-ts";

export function summarizeUpdate(props: {
  oldItem?: { [K: string]: any };
  newItem?: { [K: string]: any };
}) {
  return {
    oldItem: props.oldItem && JSON.stringify(props.oldItem, undefined, 2),
    newItem: props.newItem && JSON.stringify(props.newItem, undefined, 2),
    diff:
      props.newItem &&
      props.oldItem &&
      diffString(props.oldItem, props.newItem),
  };
}

export function addCorrelationContext(
  logger: Logger,
  context: { [K: string]: any },
) {
  logger.appendKeys({
    ...context,
  });
}

/*
 * common properties that can be searched in log insights to group logs by
 */
export function searchableAccountProperties(
  sandboxAccount: PersistedSandboxAccount,
) {
  return {
    accountId: sandboxAccount.awsAccountId,
    accountEmail: sandboxAccount.email,
    accountName: sandboxAccount.name,
  };
}

export function searchableLeaseProperties(lease: Lease) {
  const baseProps = {
    endUser: lease.userEmail,
    leaseId: lease.uuid,
    leaseTemplateId: lease.originalLeaseTemplateUuid,
    leaseTemplateName: lease.originalLeaseTemplateName,
    createdBy: lease.createdBy,
  };

  if (isMonitoredLease(lease)) {
    return {
      ...baseProps,
      accountId: lease.awsAccountId,
    };
  } else {
    return baseProps;
  }
}

export function searchableLeaseTemplateProperties(leaseTemplate: {
  uuid: string;
  name: string;
}) {
  return {
    leaseTemplateId: leaseTemplate.uuid,
    leaseTemplateName: leaseTemplate.name,
  };
}

export interface AssignmentOperationContext {
  leaseId: string;
  principalId?: string;
  principalType?: string;
  intent?: string;
  accountId?: string;
}

/**
 * Common properties for assignment operations that can be searched in
 * CloudWatch Insights to group logs by lease + principal + intent.
 */
export function searchableAssignmentProperties(
  context: AssignmentOperationContext,
) {
  return {
    leaseId: context.leaseId,
    principalId: context.principalId,
    principalType: context.principalType,
    intent: context.intent,
    accountId: context.accountId,
  };
}

export function searchableBlueprintProperties(
  blueprintWithStackSets: PersistedBlueprintWithStackSets,
) {
  const baseProperties = {
    blueprintId: blueprintWithStackSets.blueprint.blueprintId,
    blueprintName: blueprintWithStackSets.blueprint.name,
    stackSetCount: blueprintWithStackSets.stackSets.length,
  };

  // Single StackSet: Include detailed properties for the one StackSet
  if (blueprintWithStackSets.stackSets.length === 1) {
    const stackSet = blueprintWithStackSets.stackSets[0];
    return {
      ...baseProperties,
      stackSetId:
        stackSet?.stackSetId ??
        `missing-stackset-id-${blueprintWithStackSets.blueprint.blueprintId}`,
      regions: stackSet?.regions.join(",") ?? "no-regions",
    };
  }

  // Multiple StackSets: Include summary information
  return {
    ...baseProperties,
    stackSetIds: blueprintWithStackSets.stackSets
      .map((stackSet) => stackSet.stackSetId)
      .join(","),
    // Note: For multiple StackSets, regions vary per StackSet, so we don't include a single regions field
    // Use individual StackSet logs for per-StackSet region information
  };
}

export function diffString(
  oldJson: { [K: string]: any },
  newJson: { [K: string]: any },
) {
  return formatObjectDiff(diff(oldJson, newJson));
}

function formatObjectDiff(objectDiff: IChange[], nesting = 0): string {
  let output = "";
  const spacing = `${" ".repeat(nesting * 2)}`;

  if (nesting === 0) {
    output += "{";
    output += `${formatObjectDiff(objectDiff, nesting + 1)}`;
    output += "\n}";
  } else {
    objectDiff.forEach((change) => {
      const key = `"${change.key}"`;

      // Handle nested changes recursively
      if (change.changes && change.changes.length > 0) {
        output += `\n${spacing} ${key}: {${formatObjectDiff(change.changes, nesting + 1)}\n${spacing} }`;
      } else {
        switch (change.type) {
          case "UPDATE":
            output += `\n-${spacing}${key}: ${JSON.stringify(change.oldValue)}`;
            output += `\n+${spacing}${key}: ${JSON.stringify(change.value)}`;
            break;
          case "ADD":
            output += `\n+${spacing}${key}: ${JSON.stringify(change.value)}`;
            break;
          case "REMOVE":
            output += `\n-${spacing}${key}: ${JSON.stringify(change.oldValue)}`;
            break;
        }
      }
    });
  }

  return output;
}

export namespace LogPatterns {
  type LogPattern = {
    patternName: string;
    pattern: string;
  };
  export const AccountDrift: LogPattern = {
    patternName: "AccountDrift",
    pattern: "Account Drift Detected",
  };
  export const DataValidationWarning: LogPattern = {
    patternName: "DataValidationWarning",
    pattern: "Invalid Records Found",
  };
  export const EmailSendingError: LogPattern = {
    patternName: "EmailSendingError",
    pattern: "Failed to send email",
  };
  export const NotificationFailed: LogPattern = {
    patternName: "NotificationFailed",
    pattern: "Notification Delivery Failed",
  };
  export const NotificationNoChannelEnabled: LogPattern = {
    patternName: "NotificationNoChannelEnabled",
    pattern: "Notification No Channel Enabled",
  };
  export const ObservabilityLinkMissing: LogPattern = {
    patternName: "ObservabilityLinkMissing",
    pattern: "Observability Link Missing",
  };
  export const ObservabilityRegionUnreadable: LogPattern = {
    patternName: "ObservabilityRegionUnreadable",
    pattern: "Observability Region Unreadable",
  };
  export const LeaseScanSkipped: LogPattern = {
    patternName: "LeaseScanSkipped",
    pattern: "Lease Scan Skipped",
  };
  export const BedrockTokensUnattributed: LogPattern = {
    patternName: "BedrockTokensUnattributed",
    pattern: "Bedrock Tokens Unattributed",
  };
  export const BedrockUsageTypeUnclassified: LogPattern = {
    patternName: "BedrockUsageTypeUnclassified",
    pattern: "Bedrock Usage Type Unclassified",
  };
  export const BedrockTokensUnpriced: LogPattern = {
    patternName: "BedrockTokensUnpriced",
    pattern: "Bedrock Tokens Unpriced",
  };
}

export function logTaggingFailure(
  logger: Logger,
  accountId: string,
  tagKeys: IsbAccountTagSuffix[],
  error: unknown,
): void {
  const isTagSpaceExhausted =
    error instanceof ConstraintViolationException &&
    error.Reason === "MAX_TAG_LIMIT_EXCEEDED";
  logger.warn("Failed to tag account", {
    logDetailType: "TagResourceFailed",
    reason: isTagSpaceExhausted ? "TagSpaceExhausted" : "ApiError",
    accountId,
    tagKeys,
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : undefined,
  } satisfies SubscribableLog);
}

export function logUntaggingFailure(
  logger: Logger,
  accountId: string,
  tagKeys: IsbAccountTagSuffix[],
  error: unknown,
): void {
  logger.warn("Failed to untag account", {
    logDetailType: "UntagResourceFailed",
    accountId,
    tagKeys,
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : undefined,
  } satisfies SubscribableLog);
}
