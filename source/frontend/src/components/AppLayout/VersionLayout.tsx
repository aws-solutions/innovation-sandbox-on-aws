// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert, Box, Link } from "@cloudscape-design/components";
import { DateTime, Duration } from "luxon";
import React, { useState } from "react";

interface VersionAlertProps {
  latestVersion?: string;
  isNewestVersion?: boolean;
}

interface DismissalCache {
  dismissedAt: number;
}

const DISMISSAL_CACHE_KEY = "version_alert_dismissed";
const DISMISSAL_DURATION = Duration.fromObject({ weeks: 1 }).as("milliseconds");

const checkDismissalStatus = (): boolean => {
  try {
    const cached = localStorage.getItem(DISMISSAL_CACHE_KEY);
    if (!cached) {
      return false;
    }

    const { dismissedAt }: DismissalCache = JSON.parse(cached);
    const dismissedTime = DateTime.fromMillis(dismissedAt);
    const isExpired =
      DateTime.now().diff(dismissedTime).as("milliseconds") >
      DISMISSAL_DURATION;

    return !isExpired;
  } catch (error) {
    console.warn("Failed to parse version alert dismissal cache:", error);
    return false;
  }
};

export const VersionAlert: React.FC<VersionAlertProps> = ({
  latestVersion,
  isNewestVersion,
}) => {
  const [isDismissed, setIsDismissed] = useState(checkDismissalStatus());

  const shouldShowAlert = latestVersion && !isNewestVersion;

  const handleDismiss = () => {
    const dismissalData: DismissalCache = {
      dismissedAt: DateTime.now().toMillis(),
    };

    try {
      localStorage.setItem(DISMISSAL_CACHE_KEY, JSON.stringify(dismissalData));
      setIsDismissed(true);
    } catch (error) {
      console.warn("Failed to cache version alert dismissal:", error);
      setIsDismissed(true);
    }
  };

  return (
    <>
      <Box padding={{ left: "xl" }}>
        Version: <strong>v{SOLUTION_VERSION}</strong>
      </Box>
      {shouldShowAlert && !isDismissed && (
        <Box padding="s">
          <Alert type="warning" dismissible={true} onDismiss={handleDismiss}>
            A newer version {latestVersion} is available.{" "}
            <Link
              external
              href="https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/update-the-solution.html"
            >
              View update instructions
            </Link>
            <Link
              external
              href="https://github.com/aws-solutions/innovation-sandbox-on-aws/releases/latest"
            >
              View release notes
            </Link>
          </Alert>
        </Box>
      )}
    </>
  );
};
