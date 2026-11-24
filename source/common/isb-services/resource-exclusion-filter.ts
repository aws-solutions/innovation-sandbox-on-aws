// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Resource } from "@aws-sdk/client-resource-explorer-2";

/**
 * Raw exclusion configuration as stored in AppConfig.
 */
export interface ExclusionConfig {
  excludedResourceTypes: string[];
  excludedArnPatterns: string[];
}

/**
 * Result of applying exclusion rules to a set of resources.
 */
export interface ExclusionResult {
  /** Resources remaining after cleanup — potential cleanup failures. */
  remainingResources: Resource[];
  /** Resources ignored by cleanup validation (expected to persist). */
  ignoredResources: Resource[];
}

/**
 * Converts a glob pattern to a RegExp. Only `*` is treated as a wildcard
 * (matches any sequence of characters). All other regex special characters
 * are escaped. Does not support globstar (`**`) or character classes.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, String.raw`\$&`);
  const regexStr = escaped.replaceAll("*", ".*");
  return new RegExp(`^${regexStr}$`);
}

/**
 * Pre-compiled exclusion filter that partitions resources into those that
 * should be validated (potential cleanup failures) and those that are
 * expected to persist (matching exclusion rules).
 *
 * Compiles glob patterns to matchers once at construction time.
 */
export class ResourceExclusionFilter {
  private readonly arnMatchers: RegExp[];
  private readonly excludedTypes: Set<string>;

  constructor(config: ExclusionConfig) {
    this.arnMatchers = config.excludedArnPatterns.map(globToRegex);
    this.excludedTypes = new Set(config.excludedResourceTypes);
  }

  public applyExclusions(resources: Resource[]): ExclusionResult {
    const result: ExclusionResult = {
      remainingResources: [],
      ignoredResources: [],
    };

    for (const resource of resources) {
      if (this.shouldBeExcluded(resource)) {
        result.ignoredResources.push(resource);
      } else {
        result.remainingResources.push(resource);
      }
    }

    return result;
  }

  private shouldBeExcluded(resource: Resource): boolean {
    if (
      resource.ResourceType &&
      this.excludedTypes.has(resource.ResourceType)
    ) {
      return true;
    }

    if (
      resource.Arn &&
      this.arnMatchers.some((regex) => regex.test(resource.Arn!))
    ) {
      return true;
    }

    return false;
  }
}
