// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { NAMESPACE_PATTERN } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const OBSERVABILITY_SINKS_RESOURCE_TYPE = "Custom::ObservabilitySinks";

/**
 * The only telemetry type the sink admits. A link requesting more than the sink
 * permits fails outright, so the link template must use this same set.
 */
export const OBSERVABILITY_SHARED_RESOURCE_TYPES = ["AWS::CloudWatch::Metric"];

/** Mappings-shaped JSON, {"us-east-1":{"Id":"<sink id>"}}, keyed by region. */
export const SINK_IDS_JSON_ATTRIBUTE = "sinkIdsJson";
/** Second-level key of that object, looked up by the link template with Fn::FindInMap. */
export const SINK_ID_MAPPING_KEY = "Id";

/** Registering the hub for this principal lets it create service-managed StackSets. */
export const STACKSETS_DELEGATED_ADMIN_SERVICE_PRINCIPAL =
  "member.org.stacksets.cloudformation.amazonaws.com";

/** One shared sink occupies the account's single regional OAM sink slot. */
export const OBSERVABILITY_SINK_NAME = "InnovationSandbox-Metrics";

/** Stable ownership identity shared by every namespace that manages the sink. */
export const OBSERVABILITY_SINK_TAG = {
  key: "aws-solutions:isb-id",
  value: "shared_observability_isb",
} as const;

const OBSERVABILITY_POLICY_SID_PREFIX = "InnovationSandboxNamespace";

/** Identifies the one sink-policy statement owned by a namespace. */
export function observabilitySinkPolicySid(namespace: string) {
  return `${OBSERVABILITY_POLICY_SID_PREFIX}${namespace}`;
}

/**
 * Sid of the statement a shared sink holds while nothing uses it. OAM refuses
 * a policy without statements, so the sink keeps this Deny, which admits no
 * link, until a namespace joins and replaces it.
 */
export const OBSERVABILITY_SINK_VACANT_POLICY_SID =
  "InnovationSandboxNoMembers";

/**
 * Contract between the sink custom resource Lambda and the CDK construct that
 * declares it and builds the link StackSet template from its output.
 */
export const ObservabilitySinksPropertiesSchema = z.object({
  organizationId: z.string().regex(/^o-[a-z0-9]{10,32}$/),
  namespace: z.string().regex(new RegExp(NAMESPACE_PATTERN)),
  sandboxOuId: z.string().regex(/^ou-[0-9a-z]{4,32}-[a-z0-9]{8,32}$/),
  /** A list already: the shared AccountPool configuration attribute delivers it parsed. */
  managedRegions: z.array(z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d+$/)).min(1),
  hubAccountId: AwsAccountIdSchema,
  orgMgtAccountId: AwsAccountIdSchema,
  partition: z.string().regex(/^aws(-[a-z]+)*$/),
  /** Put on the shared sink; every namespace role may manage only sinks carrying it. */
  sinkTag: z.object({
    key: z.literal(OBSERVABILITY_SINK_TAG.key),
    value: z.literal(OBSERVABILITY_SINK_TAG.value),
  }),
  /** Not read by the handler; changes once per release so an upgrade re-puts the policy. */
  solutionVersion: z.string(),
});

export type ObservabilitySinksProperties = z.infer<
  typeof ObservabilitySinksPropertiesSchema
>;
