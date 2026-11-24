// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE_PATH = path.resolve(
  __dirname,
  "../../../lib/components/sandbox-agent-runtime/image/Dockerfile",
);

describe("agent runtime Dockerfile", () => {
  // The digest is written out in each FROM line, not passed through an ARG:
  // the release scan's SBOM tool does not expand ARGs in image references.
  it("pins every base image stage to the same digest", () => {
    const baseImageLines = readFileSync(DOCKERFILE_PATH, "utf8")
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("FROM ") && line.includes("amazonlinux/amazonlinux"),
      );
    const digests = baseImageLines.map(
      (line) =>
        /amazonlinux\/amazonlinux@(sha256:[a-f0-9]{64})(\s|$)/.exec(line)?.[1],
    );

    expect(baseImageLines.length).toBeGreaterThan(1);
    expect(digests).not.toContain(undefined);
    expect(new Set(digests).size).toBe(1);
  });
});
