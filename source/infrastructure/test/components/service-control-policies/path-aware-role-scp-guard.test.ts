// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  loadPolicyFromFile,
  type ScpPolicy,
} from "@amzn/innovation-sandbox-infrastructure/components/service-control-policies/scp-policy-utils";

const SCP_DIR = path.resolve(
  __dirname,
  "../../../lib/components/service-control-policies",
);
const NAMESPACE = "myisb";
const ACCOUNT = "111111111111";
const CONTROL_PLANE_POLICY_FILE = "isb-protect-control-plane-resource-scp.json";
const ORGANIZATION_ACCESS_ROLE_SID =
  "ProtectOrganizationAdministrativeAccessRole";

const toList = (value: string | string[] | undefined) =>
  value === undefined ? [] : [value].flat();

/** Every Resource pattern of every Deny statement, tagged with its origin. */
function denyResourcePatterns(policies: { file: string; policy: ScpPolicy }[]) {
  return policies.flatMap(({ file, policy }) =>
    policy.Statement.filter((statement) => statement.Effect === "Deny").flatMap(
      (statement) =>
        toList(statement.Resource).map((pattern) => ({
          file,
          sid: statement.Sid,
          pattern,
        })),
    ),
  );
}

const policies = readdirSync(SCP_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => ({
    file,
    policy: loadPolicyFromFile(file, NAMESPACE, ["us-east-1"], SCP_DIR),
  }));

const denyPatterns = denyResourcePatterns(policies);

/**
 * The subset that names a role. A role ARN carries its path
 * (`role/<path>/<name>`), so a pattern anchored at `role/` only ever matches
 * roles at the root path.
 *
 * Only isb-protect-control-plane-resource-scp.json puts roles in a Resource;
 * the other policies name roles solely in their `aws:PrincipalARN`
 * exceptions, which identify the caller and are deliberately left anchored.
 */
const rolePatterns = denyPatterns.filter(({ pattern }) =>
  pattern.includes(":role/"),
);

describe("service control policies and IAM role paths", () => {
  // An occupant holds AdministratorAccess in their sandbox account, so a role
  // pattern that misses a path lets them plant a lookalike of a protected role
  // (for example `/x/AWSReservedSSO_persist`) with an external trust policy.
  // Cleanup filters and validator exclusions match role names, so they treat
  // it as protected and it survives into the next lease.
  it("pairs every root role pattern with one for roles under a path", () => {
    expect(rolePatterns.length).toBeGreaterThan(0);

    const withoutPathPattern = rolePatterns.filter(({ sid, pattern }) => {
      const [prefix, name] = pattern.split(":role/") as [string, string];
      if (name.startsWith("*")) return false;
      return !rolePatterns.some(
        (other) =>
          other.sid === sid && other.pattern === `${prefix}:role/*/${name}`,
      );
    });

    expect(
      withoutPathPattern.map(
        ({ file, sid, pattern }) => `${file} ${sid}: ${pattern}`,
      ),
    ).toEqual([]);
  });

  // `role/*name*` would also cover paths, but it turns the name match from a
  // prefix into a substring: it denies `team-aws-controltower-helper`, which
  // aws-nuke's `aws-controltower-*` filter does not keep. Cleanup would then
  // try to delete a role this SCP stops it deleting. `role/*/name*` keeps the
  // boundary, because the name must follow a `/`.
  it("keeps the role-name boundary in path patterns", () => {
    const substring = rolePatterns.filter(({ pattern }) => {
      const name = pattern.split(":role/")[1]!;
      return name.startsWith("*") && !name.startsWith("*/");
    });

    // The one deliberate substring match: it mirrors the aws-nuke filter
    // `contains: AWSControlTower`, so cleanup keeps every role it covers.
    expect(substring.map(({ pattern }) => pattern)).toEqual([
      "arn:aws:iam::*:role/*AWSControlTower*",
    ]);
  });

  // `role/*` or `role/*/*` would satisfy the rules above by denying every role
  // in the account. Each pattern must still name what it protects.
  it("does not protect roles with a bare wildcard", () => {
    expect(
      rolePatterns.filter(({ pattern }) => /:role\/(\*\/)?\*+$/.test(pattern)),
    ).toEqual([]);
  });

  it("protects creating OrganizationAccountAccessRole at any IAM path", () => {
    const policy = policies.find(
      ({ file }) => file === CONTROL_PLANE_POLICY_FILE,
    )?.policy;
    const statement = policy?.Statement.find(
      ({ Sid }) => Sid === ORGANIZATION_ACCESS_ROLE_SID,
    );

    expect(statement).toBeDefined();
    expect(toList(statement?.Action)).toContain("iam:CreateRole");
    expect(toList(statement?.Resource)).toEqual([
      "arn:aws:iam::*:role/OrganizationAccountAccessRole",
      "arn:aws:iam::*:role/*/OrganizationAccountAccessRole",
    ]);
  });

  // Spot-checks of the intended outcome, so a reader sees which ARNs these
  // patterns are meant to cover. The decisions were confirmed against IAM
  // itself with `iam:SimulateCustomPolicy`.
  describe("the ISB and Control Tower role patterns", () => {
    const denies = (rolePathAndName: string) =>
      denyPatterns.some(({ pattern }) =>
        arnLike(pattern, `arn:aws:iam::${ACCOUNT}:role/${rolePathAndName}`),
      );

    it.each([
      "AWSReservedSSO_persist",
      "x/AWSReservedSSO_persist",
      "a/b/AWSReservedSSO_persist",
      "aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_0123456789abcdef",
      `InnovationSandbox-${NAMESPACE}-Lookalike`,
      `x/InnovationSandbox-${NAMESPACE}-Lookalike`,
      `SandboxAgentRole-${NAMESPACE}`,
      `x/SandboxAgentRole-${NAMESPACE}`,
      "stacksets-exec-lookalike",
      "x/stacksets-exec-lookalike",
      "aws-controltower-Lookalike",
      "x/aws-controltower-Lookalike",
      "a/b/aws-controltower-Lookalike",
      "OrganizationAccountAccessRole",
      "x/OrganizationAccountAccessRole",
      "a/b/OrganizationAccountAccessRole",
    ])("cover a role at %s", (rolePathAndName) => {
      expect(denies(rolePathAndName)).toBe(true);
    });

    it.each([
      "my-app-role",
      "service/my-app-role",
      `SandboxAgentRole-${NAMESPACE}-extra`,
      // Names that only contain a protected prefix. aws-nuke's prefix filters
      // do not keep them, so the SCP must not stop cleanup deleting them.
      "team-aws-controltower-helper",
      "x/team-aws-controltower-helper",
      "my-stacksets-exec-helper",
      "x/my-stacksets-exec-helper",
      `Team-InnovationSandbox-${NAMESPACE}-helper`,
      `x/Team-InnovationSandbox-${NAMESPACE}-helper`,
      `My-SandboxAgentRole-${NAMESPACE}`,
      "MyAWSReservedSSO_helper",
      "MyOrganizationAccountAccessRole",
      "OrganizationAccountAccessRole-extra",
      "x/MyOrganizationAccountAccessRole",
    ])("leave a role at %s alone", (rolePathAndName) => {
      expect(denies(rolePathAndName)).toBe(false);
    });
  });
});

/**
 * ARN matching for a policy Resource element. The six colon-separated ARN
 * segments are compared one by one: a `*` spans any characters within its own
 * segment, including the `/` that separates a role's path from its name, but
 * never the `:` between segments. Confirmed with `iam:SimulateCustomPolicy`,
 * which denies `arn:aws:iam::*` on a role yet allows `arn:aws:iam*my-app-role`.
 */
function arnLike(pattern: string, arn: string): boolean {
  const segments = (value: string) => {
    const parts = value.split(":");
    return [...parts.slice(0, 5), parts.slice(5).join(":")];
  };
  const patternSegments = segments(pattern);
  const arnSegments = segments(arn);
  return patternSegments.every((segment, index) => {
    const expression = segment
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".");
    return new RegExp(`^${expression}$`).test(arnSegments[index]!);
  });
}
