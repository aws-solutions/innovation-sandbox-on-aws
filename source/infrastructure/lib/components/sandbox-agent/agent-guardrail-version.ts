// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import {
  CfnGuardrail,
  type CfnGuardrailProps,
  CfnGuardrailVersion,
} from "aws-cdk-lib/aws-bedrock";
import { Construct } from "constructs";
import { createHash } from "node:crypto";

import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";

type GuardrailBehaviour = Record<
  Exclude<keyof CfnGuardrailProps, "name" | "tags">,
  unknown
>;

/**
 * Hash of the guardrail's configuration. Tokens are resolved first, so the
 * value only changes when the configuration does, not when unrelated
 * constructs shift CDK's token numbering.
 */
export function guardrailConfigFingerprint(guardrail: CfnGuardrail): string {
  const behaviour: GuardrailBehaviour = {
    automatedReasoningPolicyConfig: guardrail.automatedReasoningPolicyConfig,
    blockedInputMessaging: guardrail.blockedInputMessaging,
    blockedOutputsMessaging: guardrail.blockedOutputsMessaging,
    contentPolicyConfig: guardrail.contentPolicyConfig,
    contextualGroundingPolicyConfig: guardrail.contextualGroundingPolicyConfig,
    crossRegionConfig: guardrail.crossRegionConfig,
    description: guardrail.description,
    kmsKeyArn: guardrail.kmsKeyArn,
    sensitiveInformationPolicyConfig:
      guardrail.sensitiveInformationPolicyConfig,
    topicPolicyConfig: guardrail.topicPolicyConfig,
    wordPolicyConfig: guardrail.wordPolicyConfig,
  };
  return createHash("sha256")
    .update(JSON.stringify(Stack.of(guardrail).resolve(behaviour)))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Every AWS::Bedrock::GuardrailVersion property requires replacement, so the
 * fingerprint in the description publishes a new version whenever the
 * configuration changes, and an unchanged configuration keeps the current one.
 */
export function publishGuardrailVersion(
  scope: Construct,
  id: string,
  guardrail: CfnGuardrail,
): CfnGuardrailVersion {
  const version = new CfnGuardrailVersion(scope, id, {
    guardrailIdentifier: guardrail.attrGuardrailId,
    description: `Sandbox Agent guardrail configuration ${guardrailConfigFingerprint(guardrail)}`,
  });
  version.applyRemovalPolicy(RemovalPolicy.RETAIN);
  return version;
}

export function guardrailVersionForDeployment(
  scope: Construct,
  id: string,
  guardrail: CfnGuardrail,
): string {
  return isDevMode(scope)
    ? "DRAFT"
    : publishGuardrailVersion(scope, id, guardrail).attrVersion;
}
