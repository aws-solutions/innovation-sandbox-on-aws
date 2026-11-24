// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { FileSystem, IgnoreMode } from "aws-cdk-lib";
import { createHash } from "node:crypto";
import path from "node:path";

const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function privateImageReference(digest: string | undefined): string {
  if (digest === undefined) return `:${agentRuntimeSourceTag()}`;
  if (!IMAGE_DIGEST_PATTERN.test(digest)) {
    throw new Error(
      `sandboxAgentRuntimeImageDigest must look like sha256:<64 hex>, got "${digest}"`,
    );
  }
  return `@${digest}`;
}

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..", "..");

/**
 * The image's build inputs: the Dockerfile's directory and what it copies, as
 * staged by deployment/build-s3-dist.sh.
 */
const IMAGE_INPUTS = [
  "source/infrastructure/lib/components/sandbox-agent-runtime/image",
  "package.json",
  "package-lock.json",
  "source/common",
  "source/shared",
  "source/agent-runtime",
  "source/layers/dependencies/package.json",
];

/** Excluded from the build context by deployment/build-s3-dist.sh. */
const EXCLUDED = [
  "node_modules",
  "dist",
  "test",
  "coverage",
  "vitest.config.ts",
  "*.tsbuildinfo",
];

/**
 * A fingerprint of the image's source. Set as a runtime environment variable so
 * a source change creates a runtime version, which pulls the image currently
 * under the tag. This covers builds where the digest is not known at synth time
 * (the pipeline builds templates before it pushes images).
 */
export function agentRuntimeSourceHash(): string {
  const hash = createHash("sha256");
  for (const input of IMAGE_INPUTS) {
    hash.update(input);
    hash.update(
      FileSystem.fingerprint(path.join(REPO_ROOT, input), {
        exclude: EXCLUDED,
        ignoreMode: IgnoreMode.GLOB,
      }),
    );
  }
  return hash.digest("hex");
}

/**
 * Tag scripts/docker pushes the private-repository image under, naming the
 * source it was built from. scripts/cdk/deploy.sh builds and pushes an image
 * when none exists under the current source's tag, and pins the runtime to its
 * digest.
 */
export function agentRuntimeSourceTag(): string {
  return `source-${agentRuntimeSourceHash()}`;
}
