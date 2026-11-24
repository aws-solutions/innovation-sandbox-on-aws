// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PersistedMonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { SandboxAccountStatus } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";

/**
 * Semantic suffixes for the ISB account tags. The tag key written to an account
 * is namespaced — `ISB-<namespace>:<suffix>`.
 */
export const ISB_ACCOUNT_TAG_SUFFIXES = [
  "LeaseId",
  "CostReportGroup",
  "LeaseTemplate",
  "User",
  "Status",
] as const;

export type IsbAccountTagSuffix = (typeof ISB_ACCOUNT_TAG_SUFFIXES)[number];

/** Any subset of the ISB account tags with string values, keyed by suffix. */
export type IsbAccountTags = Partial<Record<IsbAccountTagSuffix, string>>;

/** Valid values for the Status tag — alias of SandboxAccountStatus. */
export { SandboxAccountStatusSchema as IsbStatusTagValueSchema } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";
export type IsbStatusTagValue = SandboxAccountStatus;

export const ISB_ACCOUNT_TAG_SPACE_LIMIT = 45;

export const NO_COST_REPORT_GROUP_TAG_VALUE = "No cost report group";

export const isbTagKeyPrefix = (namespace: string) => `ISB-${namespace}:`;

export const toIsbTagKey = (namespace: string, suffix: IsbAccountTagSuffix) =>
  `${isbTagKeyPrefix(namespace)}${suffix}`;

/**
 * All ISB account tag keys for a deployment. Must stay in sync with the IAM
 * aws:TagKeys condition on the Org Management Role.
 */
export const isbAccountTagKeys = (namespace: string) =>
  ISB_ACCOUNT_TAG_SUFFIXES.map((suffix) => toIsbTagKey(namespace, suffix));

export const CE_ACCOUNT_TAG_PREFIX = "accountTag/";

export const toCeTagKey = (key: string) => `${CE_ACCOUNT_TAG_PREFIX}${key}`;
export const fromCeTagKey = (key: string) =>
  key.startsWith(CE_ACCOUNT_TAG_PREFIX)
    ? key.slice(CE_ACCOUNT_TAG_PREFIX.length)
    : key;

export type IsbLeaseTagSuffix = Exclude<IsbAccountTagSuffix, "Status">;

export const ISB_LEASE_TAG_SUFFIXES: IsbLeaseTagSuffix[] =
  ISB_ACCOUNT_TAG_SUFFIXES.filter(
    (suffix): suffix is IsbLeaseTagSuffix => suffix !== "Status",
  );

export type IsbLeaseTagSet = { readonly [K in IsbLeaseTagSuffix]: string };

export function buildLeaseTagSet(
  lease: PersistedMonitoredLease,
  userId: string,
): IsbLeaseTagSet {
  return {
    LeaseId: lease.uuid,
    CostReportGroup: lease.costReportGroup ?? NO_COST_REPORT_GROUP_TAG_VALUE,
    LeaseTemplate: lease.originalLeaseTemplateUuid,
    User: userId,
  };
}

/**
 * CE returns TAG-grouped rows with keys shaped as `"TagKey$TagValue"`. An empty
 * tag value yields `"TagKey$"`. Returns the value portion (possibly empty), or
 * `undefined` if the input is missing or malformed.
 */
export function parseTagGroupValue(
  groupKey: string | undefined,
): string | undefined {
  if (!groupKey) return undefined;
  const sep = groupKey.indexOf("$");
  if (sep < 0) return undefined;
  return groupKey.slice(sep + 1);
}
