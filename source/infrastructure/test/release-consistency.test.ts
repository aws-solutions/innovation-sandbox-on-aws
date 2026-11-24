// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { readManifest } from "@amzn/innovation-sandbox-infrastructure/helpers/manifest-reader";

interface PackageJson {
  version: string;
}

interface ManifestVersion {
  major: string;
  minor: string;
  patch: string;
}

type EcrImageTags = Record<string, string>;

const projectRoot = path.resolve(__dirname, "../../..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(projectRoot, relativePath), "utf8"),
  ) as T;
}

function parseManifestVersion(version: string): ManifestVersion {
  const versionMatch =
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev)?$/.exec(version);

  expect(
    versionMatch,
    "solution manifest version must use vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-dev",
  ).not.toBeNull();

  if (versionMatch === null) {
    throw new Error("Unable to parse the solution manifest version");
  }

  const [, major, minor, patch] = versionMatch;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error("Unable to parse the solution manifest version");
  }

  return { major, minor, patch };
}

describe("release metadata consistency", () => {
  it("keeps the package version aligned with the solution manifest", () => {
    const manifest = readManifest();
    const packageJson = readJson<PackageJson>("package.json");
    const { major, minor, patch } = parseManifestVersion(manifest.version);
    const expectedPackageVersion = `${major}.${minor}.${patch}`;

    expect(
      packageJson.version,
      "package.json version must match the solution manifest version",
    ).toBe(expectedPackageVersion);
  });

  it("keeps stable ECR image tags aligned with the solution manifest", () => {
    const manifest = readManifest();
    const ecrImageTags = readJson<EcrImageTags>(
      "deployment/ecr_image_tags.json",
    );
    const { major, minor } = parseManifestVersion(manifest.version);
    const expectedStableTag = `v${major}.${minor}`;
    // Only the account cleaner is pulled by its stable tag (UseStableTagging).
    // The agent runtime always uses the full version tag.
    const stableTaggedImages = ["innovation-sandbox-on-aws-account-cleaner"];

    expect(Object.keys(ecrImageTags).sort()).toEqual(stableTaggedImages);
    expect(manifest.container_images).toEqual(
      expect.arrayContaining(stableTaggedImages),
    );

    for (const [imageName, imageTag] of Object.entries(ecrImageTags)) {
      expect(imageTag, `${imageName} must use the current stable tag`).toBe(
        expectedStableTag,
      );
    }
  });
});
