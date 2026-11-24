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

type Statement = ScpPolicy["Statement"][number];

const toList = (value: string | string[] | undefined) =>
  value === undefined ? [] : [value].flat();

// A deny reaches oam actions when it denies everything, names oam, or
// allowlists actions without covering oam.
function deniesOam(statement: Statement): boolean {
  if (statement.Effect !== "Deny") {
    return false;
  }
  const actions = toList(statement.Action).map((a) => a.toLowerCase());
  if (actions.some((a) => a === "*" || a.startsWith("oam:"))) {
    return true;
  }
  const notActions = toList(statement.NotAction).map((a) => a.toLowerCase());
  return (
    notActions.length > 0 &&
    !notActions.some((a) => a === "*" || a.startsWith("oam:"))
  );
}

// Occupants must never hold OAM permissions, or they could delete the link
// that shares their Bedrock metrics or create links cleanup cannot remove. The
// StackSet execution role is the one principal that must keep them.
describe("service control policies and the observability link", () => {
  const policies = readdirSync(SCP_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      file,
      policy: loadPolicyFromFile(file, undefined, undefined, SCP_DIR),
    }));

  it("keeps every oam action out of every SCP allowlist", () => {
    // a NotAction that names oam would not deny it, so the exemption test
    // below would never see that statement either
    const allowlisted = policies.flatMap(({ file, policy }) =>
      policy.Statement.flatMap((s) =>
        toList(s.NotAction).map((action) => `${file}: ${action}`),
      ),
    );

    expect(allowlisted.length).toBeGreaterThan(0);
    expect(
      allowlisted.filter((entry) => entry.toLowerCase().includes(": oam:")),
    ).toEqual([]);
  });

  it("exempts the StackSet execution role from every deny that reaches oam", () => {
    const reaching = policies.flatMap(({ file, policy }) =>
      policy.Statement.filter(deniesOam).map((s) => ({ file, sid: s.Sid, s })),
    );

    expect(reaching.length).toBeGreaterThan(0);
    for (const { file, sid, s } of reaching) {
      const exempt = JSON.stringify(
        s.Condition?.ArnNotLike?.["aws:PrincipalARN"] ?? [],
      );
      expect(exempt, `${file} ${sid}`).toContain("role/stacksets-exec-*");
    }
  });
});
