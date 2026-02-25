// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { BlueprintWithStackSets } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  isMonitoredLease,
  Lease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { SandboxAccount } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { Logger } from "@aws-lambda-powertools/logger";
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
export function searchableAccountProperties(sandboxAccount: SandboxAccount) {
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

export function searchableLeaseTemplateProperties(
  leaseTemplate: LeaseTemplate,
) {
  return {
    leaseTemplateId: leaseTemplate.uuid,
    leaseTemplateName: leaseTemplate.name,
  };
}

export function searchableBlueprintProperties(
  blueprintWithStackSets: BlueprintWithStackSets,
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

export namespace AppInsightsLogPatterns {
  type AppInsightsLogPattern = {
    patternName: string;
    pattern: string;
  };
  export const AccountDrift: AppInsightsLogPattern = {
    patternName: "AccountDrift",
    pattern: "Account Drift Detected",
  };
  export const DataValidationWarning = {
    patternName: "DataValidationWarning",
    pattern: "Invalid Records Found",
  };
  export const EmailSendingError = {
    patternName: "EmailSendingError",
    pattern: "Failed to send email",
  };
}
