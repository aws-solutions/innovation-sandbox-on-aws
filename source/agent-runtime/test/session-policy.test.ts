// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  buildSessionPermissions,
  hasPermissions,
  PermissionProfile,
} from "@amzn/innovation-sandbox-agent-runtime/session-policy.js";
import type { PolicyDocument } from "@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js";

const READ_ONLY_ARN = "arn:aws:iam::aws:policy/ReadOnlyAccess";

const managedOnly: PermissionProfile = { managedPolicyArns: [READ_ONLY_ARN] };

const isbControlPlaneDeny = (policy: PolicyDocument) =>
  policy.Statement.find((s) => s.Sid === "IsbControlPlaneDeny");

describe("buildSessionPermissions", () => {
  it("always includes the base deny on ISB control-plane resources", () => {
    const { policy } = buildSessionPermissions(managedOnly);
    const deny = isbControlPlaneDeny(policy);
    expect(deny).toBeDefined();
    expect(deny!.Effect).toBe("Deny");
    expect(deny!.Resource).toContain(
      "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*",
    );
    expect(deny!.Resource).toContain("arn:aws:iam::*:role/InnovationSandbox-*");
  });

  it("adds no Allow statement for a managed-only permission set", () => {
    // A managed-only permission set relies on PolicyArns for its allows. STS
    // combines inline and managed session policies where any allow counts, so
    // an allow here would nullify the managed policies' restriction.
    const { policy, policyArns } = buildSessionPermissions(managedOnly);
    expect(policy.Statement.every((s) => s.Effect === "Deny")).toBe(true);
    expect(policyArns).toEqual([READ_ONLY_ARN]);
  });

  it("merges the inline policy statements and passes managed ARNs separately", () => {
    const inlinePolicy: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["s3:*"], Resource: "*" },
        { Effect: "Allow", Action: ["ec2:Describe*"], Resource: "*" },
      ],
    };
    const { policy, policyArns } = buildSessionPermissions({
      inlinePolicy,
      managedPolicyArns: [READ_ONLY_ARN],
    });

    expect(policy.Statement).toEqual(
      expect.arrayContaining([...inlinePolicy.Statement]),
    );
    // No allow-all statement is added alongside the profile
    expect(
      policy.Statement.find((s) => s.Effect === "Allow" && s.Action === "*"),
    ).toBeUndefined();
    // Base deny still present and last
    expect(isbControlPlaneDeny(policy)).toBeDefined();
    expect(policy.Statement.at(-1)?.Effect).toBe("Deny");
    expect(policyArns).toEqual([READ_ONLY_ARN]);
  });

  it("leaves policyArns undefined for an inline-only permission set", () => {
    const { policyArns } = buildSessionPermissions({
      inlinePolicy: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: "*" }],
      },
      managedPolicyArns: [],
    });
    expect(policyArns).toBeUndefined();
  });

  it("interpolates the deployment partition into the base deny ARNs", () => {
    const { policy } = buildSessionPermissions(managedOnly, {
      partition: "aws-us-gov",
    });
    const deny = isbControlPlaneDeny(policy);
    expect(deny!.Resource).toContain(
      "arn:aws-us-gov:iam::*:role/aws-reserved/sso.amazonaws.com/*",
    );
    expect(deny!.Resource).toContain(
      "arn:aws-us-gov:iam::*:role/InnovationSandbox-*",
    );
  });

  it("defaults the partition to aws", () => {
    const deny = isbControlPlaneDeny(
      buildSessionPermissions(managedOnly).policy,
    );
    expect(deny!.Resource).toContain(
      "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*",
    );
  });

  it("produces a valid policy document version", () => {
    expect(buildSessionPermissions(managedOnly).policy.Version).toBe(
      "2012-10-17",
    );
  });
});

describe("hasPermissions", () => {
  it("is true with an inline policy, managed policies, or both", () => {
    const inlinePolicy: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: "*" }],
    };
    expect(hasPermissions({ inlinePolicy, managedPolicyArns: [] })).toBe(true);
    expect(hasPermissions(managedOnly)).toBe(true);
    expect(
      hasPermissions({ inlinePolicy, managedPolicyArns: [READ_ONLY_ARN] }),
    ).toBe(true);
  });

  it("is false with neither", () => {
    expect(hasPermissions({ managedPolicyArns: [] })).toBe(false);
  });
});
