// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { build as buildArn } from "@aws-sdk/util-arn-parser";

import {
  IsbRole,
  IsbRoleSchema,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

/**
 * Tags the CDK stamps on every M2M client IAM role; M2M clients have no
 * registry, so they are discovered by these tags. Source of truth for the
 * stack-type tag — `isb-m2m-client-resources.ts` imports these.
 */
export const M2M_STACK_TYPE_TAG_KEY = "aws-solutions:isb-stack-type";
export const M2M_STACK_TYPE_TAG_VALUE = "M2mClient";
// Deployment-scoping tag applied to every stack by `applyIsbTag`
// (infra `tagging-helper.ts` `isbTagName`/`isbTagValueSuffix`); duplicated here
// because common cannot import infra. Value is `<namespace>_isb`.
export const M2M_ISB_ID_TAG_KEY = "aws-solutions:isb-id";

/**
 * Canonical name builder + parser for M2M IAM roles.
 *
 * The role name has the shape `<namespace>-isb-m2m-<roleTier>-<clientName>`
 * where `<roleTier>` is an IsbRole value lowercased. The CDK construct that
 * creates the role, the test fixture that synthesizes assumed-role ARNs, and
 * the middleware that authenticates incoming SigV4 requests must all agree on
 * this shape — divergence breaks auth silently. Keep the format here as the
 * single source of truth.
 */

export const M2M_ROLE_NAME_INFIX = "isb-m2m";

/**
 * The namespace-scoped M2M segment (`isb-m2m/<namespace>`) shared by the role's
 * IAM path and its ARN — the single source of truth for where M2M roles live.
 * Callers add the delimiting slashes their context needs, since those differ:
 *   - IAM role `path` / `ListRoles` PathPrefix: `/${buildM2mRolePrefix(ns)}/`
 *     (must start AND end with `/`; the trailing `/` anchors the prefix to a
 *     whole path segment so `myisb` doesn't also match `myisb2`)
 *   - ARN resource segment: `${buildM2mRolePrefix(ns)}/${name}` (formatArn adds
 *     the leading slash after `role`)
 * Distinct from the role *name* prefix (`<ns>-isb-m2m-`) used to filter by name.
 */
export function buildM2mRolePrefix(namespace: string): string {
  return `${M2M_ROLE_NAME_INFIX}/${namespace}`;
}

/**
 * Builds the IAM role name a CDK construct uses for an M2M client.
 */
export function buildM2mRoleName(
  namespace: string,
  roleTier: IsbRole,
  clientName: string,
): string {
  return `${namespace}-${M2M_ROLE_NAME_INFIX}-${roleTier.toLowerCase()}-${clientName}`;
}

/**
 * Builds the assumed-role ARN a SigV4-signed M2M call surfaces in
 * `event.requestContext.identity.userArn`. Used by tests to synthesize
 * realistic events.
 */
export function buildM2mAssumedRoleArn(args: {
  namespace: string;
  roleTier: IsbRole;
  clientName: string;
  accountId: string;
  partition?: string;
  sessionName?: string;
}): string {
  const {
    namespace,
    roleTier,
    clientName,
    accountId,
    partition,
    sessionName = "session-name",
  } = args;
  // STS ARNs are global — `region` is empty by spec.
  return buildArn({
    partition,
    service: "sts",
    region: "",
    accountId,
    resource: `assumed-role/${buildM2mRoleName(namespace, roleTier, clientName)}/${sessionName}`,
  });
}

// The role-tier alternation is built from IsbRoleSchema.options so a future
// role addition is a one-place change. Partition is a wildcard so non-`aws`
// partitions (`aws-cn`, `aws-us-gov`) are matched correctly at runtime.
const M2M_ROLE_TIER_PATTERN = IsbRoleSchema.options
  .map((r) => r.toLowerCase())
  .join("|");

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export interface ParsedM2mAssumedRoleArn {
  /** The role tier as it appears in the ARN — always lowercase. */
  roleTier: string;
  /** The per-client suffix. Mandatory on legitimate M2M roles. */
  clientName: string;
}

/**
 * Parses an assumed-role ARN and returns `{ roleTier, clientName }` if it
 * matches the M2M role-name shape for the given namespace, otherwise `null`.
 *
 * The regex is namespace-anchored, case-insensitive, and requires a
 * non-empty `clientName` — so look-alike roles without a client suffix
 * (e.g. `evil-isb-m2m-admin-x`) do not match and fall through to the user
 * path on the caller side.
 */
export function parseM2mAssumedRoleArn(
  arn: string | undefined | null,
  namespace: string,
  expectedAccountId: string,
): ParsedM2mAssumedRoleArn | null {
  if (!arn) return null;
  const escapedNamespace = escapeRegExp(namespace);
  const escapedAccountId = escapeRegExp(expectedAccountId);
  const regex = new RegExp(
    String.raw`^arn:[a-z0-9-]+:sts::${escapedAccountId}:assumed-role/${escapedNamespace}-${M2M_ROLE_NAME_INFIX}-(${M2M_ROLE_TIER_PATTERN})-([a-z0-9-]+)/`,
    "i",
  );
  const match = regex.exec(arn);
  if (!match) return null;
  return { roleTier: match[1]!, clientName: match[2]! };
}
