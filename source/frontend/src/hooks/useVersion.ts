// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { DateTime, Duration } from "luxon";

interface VersionCheckResult {
  latestVersion: string;
  isNewestVersion: boolean;
}

interface UseVersionCheckOptions {
  enabled?: boolean;
}

const CACHE_KEY = "github_latest_version";
const CACHE_DURATION = Duration.fromObject({ days: 1 }).as("milliseconds");
const GITHUB_API =
  "https://api.github.com/repos/aws-solutions/innovation-sandbox-on-aws/releases/latest";

const checkLatestVersion = async (
  currentVersion: string,
): Promise<VersionCheckResult> => {
  const versionCompare = `v${currentVersion}`;
  const cached = localStorage.getItem(CACHE_KEY);

  if (cached) {
    try {
      const { data, timeStamp } = JSON.parse(cached);
      const cachedTime = DateTime.fromMillis(timeStamp);
      const isExpired =
        DateTime.now().diff(cachedTime).as("milliseconds") > CACHE_DURATION;
      if (!isExpired) {
        return {
          latestVersion: data.tag_name,
          isNewestVersion: versionCompare === data.tag_name,
        };
      }
    } catch (error) {
      console.warn("Failed to parse cached version data:", error);
    }
  }

  const response = await fetch(GITHUB_API);

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`,
    );
  }

  const { tag_name } = await response.json();

  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        data: { tag_name },
        timeStamp: DateTime.now().toMillis(),
      }),
    );
  } catch (error) {
    console.warn("Failed to cache version data:", error);
  }

  return {
    latestVersion: tag_name,
    isNewestVersion: versionCompare === tag_name,
  };
};

export const useVersionCheck = (options?: UseVersionCheckOptions) => {
  return useQuery({
    queryKey: ["version-check", SOLUTION_VERSION],
    queryFn: () => checkLatestVersion(SOLUTION_VERSION),
    staleTime: 60 * 60 * 1000,
    retry: 1,
    retryDelay: 5000,
    enabled: options?.enabled ?? false,
  });
};
