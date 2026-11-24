// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { App, CfnParameter, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { CfnGuardrail, type CfnGuardrailProps } from "aws-cdk-lib/aws-bedrock";
import { describe, expect, it } from "vitest";

import {
  guardrailConfigFingerprint,
  guardrailVersionForDeployment,
  publishGuardrailVersion,
} from "@amzn/innovation-sandbox-infrastructure/components/sandbox-agent/agent-guardrail-version";

const BASE_PROPS: Omit<CfnGuardrailProps, "name"> = {
  blockedInputMessaging: "Input blocked.",
  blockedOutputsMessaging: "Output blocked.",
  contentPolicyConfig: {
    filtersConfig: [
      { type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" },
    ],
  },
};

function buildStack(
  props: Omit<CfnGuardrailProps, "name"> = BASE_PROPS,
  options: { namespace?: string; extraConstructs?: number } = {},
) {
  const stack = new Stack(new App(), "TestStack");
  // Unrelated tokens created first shift CDK's token numbering.
  for (let i = 0; i < (options.extraConstructs ?? 0); i++) {
    new CfnParameter(stack, `Unrelated${i}`, { type: "String" });
  }
  const namespace = new CfnParameter(stack, "Namespace", {
    type: "String",
    default: options.namespace ?? "myisb",
  });
  const guardrail = new CfnGuardrail(stack, "Guardrail", {
    name: `ISB-${namespace.valueAsString}-Guardrail`,
    ...props,
  });
  const version = publishGuardrailVersion(stack, "GuardrailVersion", guardrail);
  return { stack, guardrail, version };
}

describe("publishGuardrailVersion", () => {
  it("publishes a version of the guardrail", () => {
    const { stack } = buildStack();

    Template.fromStack(stack).hasResourceProperties(
      "AWS::Bedrock::GuardrailVersion",
      {
        GuardrailIdentifier: {
          "Fn::GetAtt": [Match.stringLikeRegexp("^Guardrail"), "GuardrailId"],
        },
        Description: Match.stringLikeRegexp(
          "^Sandbox Agent guardrail configuration [0-9a-f]{16}$",
        ),
      },
    );
  });

  // Sessions started before a deploy keep applying the old version, so
  // CloudFormation must not delete it on replacement or removal.
  it("retains superseded versions", () => {
    const { stack } = buildStack();

    Template.fromStack(stack).hasResource("AWS::Bedrock::GuardrailVersion", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });
});

describe("guardrailVersionForDeployment", () => {
  function versionFor(deploymentMode?: string) {
    const stack = new Stack(
      new App({ context: deploymentMode ? { deploymentMode } : {} }),
      "TestStack",
    );
    const guardrail = new CfnGuardrail(stack, "Guardrail", {
      name: "Guardrail",
      ...BASE_PROPS,
    });
    const version = guardrailVersionForDeployment(
      stack,
      "GuardrailVersion",
      guardrail,
    );
    return { version, template: Template.fromStack(stack), stack };
  }

  it.each([undefined, "prod"])(
    "applies a published version in %s mode",
    (deploymentMode) => {
      const { version, template, stack } = versionFor(deploymentMode);

      template.resourceCountIs("AWS::Bedrock::GuardrailVersion", 1);
      expect(stack.resolve(version)).toEqual({
        "Fn::GetAtt": [expect.stringMatching(/^GuardrailVersion/), "Version"],
      });
    },
  );

  it("applies DRAFT in dev mode and publishes no version", () => {
    const { version, template } = versionFor("dev");

    expect(version).toBe("DRAFT");
    template.resourceCountIs("AWS::Bedrock::GuardrailVersion", 0);
  });
});

describe("guardrailConfigFingerprint", () => {
  const fingerprint = (...args: Parameters<typeof buildStack>) =>
    guardrailConfigFingerprint(buildStack(...args).guardrail);

  it("is stable for the same configuration", () => {
    expect(fingerprint()).toBe(fingerprint());
  });

  it("ignores unrelated changes to CDK's token numbering", () => {
    expect(fingerprint(BASE_PROPS, { extraConstructs: 5 })).toBe(fingerprint());
  });

  it("ignores the name and tags, which do not change behaviour", () => {
    expect(
      fingerprint(
        { ...BASE_PROPS, tags: [{ key: "team", value: "isb" }] },
        { namespace: "other" },
      ),
    ).toBe(fingerprint());
  });

  // A changed fingerprint changes the version's description, which replaces
  // the resource and so publishes a new version.
  it.each<[string, Omit<CfnGuardrailProps, "name">]>([
    [
      "a filter strength",
      {
        ...BASE_PROPS,
        contentPolicyConfig: {
          filtersConfig: [
            {
              type: "PROMPT_ATTACK",
              inputStrength: "MEDIUM",
              outputStrength: "NONE",
            },
          ],
        },
      },
    ],
    [
      "the blocked-input message",
      { ...BASE_PROPS, blockedInputMessaging: "No." },
    ],
    [
      "a sensitive-information policy",
      {
        ...BASE_PROPS,
        sensitiveInformationPolicyConfig: {
          piiEntitiesConfig: [{ type: "PASSWORD", action: "ANONYMIZE" }],
        },
      },
    ],
  ])("changes when %s changes", (_change, props) => {
    expect(fingerprint(props)).not.toBe(fingerprint());
  });
});
