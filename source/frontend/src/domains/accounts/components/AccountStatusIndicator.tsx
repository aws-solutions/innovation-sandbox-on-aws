// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Icon, Popover } from "@cloudscape-design/components";
import { colorChartsStatusHigh } from "@cloudscape-design/design-tokens";
import { DateTime } from "luxon";

import { getColor } from "@amzn/innovation-sandbox-frontend/components/AccountsSummary/helpers";
import { getCleanupStatusConfig } from "@amzn/innovation-sandbox-frontend/domains/accounts/helpers";
import {
  ActiveCleanup,
  SandboxAccountStatus,
} from "@amzn/innovation-sandbox-shared/types/sandbox-account";

interface AccountStatusIndicatorProps {
  status: SandboxAccountStatus;
  activeCleanup?: ActiveCleanup;
  /** @deprecated Use activeCleanup.startedAt instead */
  lastCleanupStartTime?: string;
}

export const AccountStatusIndicator = ({
  status,
  activeCleanup,
  lastCleanupStartTime, // NOSONAR typescript:S1874: Support stored accounts that predate activeCleanup.
}: AccountStatusIndicatorProps) => {
  switch (status) {
    case "Available":
      return (
        <span style={{ color: getColor(status) }}>
          <Icon name="status-positive" /> Available
        </span>
      );

    case "Active":
      return (
        <span style={{ color: getColor(status) }}>
          <Icon name="status-in-progress" /> Active
        </span>
      );

    case "Frozen":
      return (
        <span style={{ color: getColor(status) }}>
          <Icon name="status-stopped" /> Frozen
        </span>
      );

    case "CleanUp": {
      const cleanupStartTime = activeCleanup?.startedAt ?? lastCleanupStartTime;

      const cleanupLabel = activeCleanup
        ? `Clean Up (${getCleanupStatusConfig(activeCleanup.status).label})`
        : "Clean Up";

      if (!cleanupStartTime) {
        const color = getColor(status);
        return (
          <span style={{ color }}>
            <Icon name="remove" /> {cleanupLabel}
          </span>
        );
      }

      const hoursElapsed = DateTime.now().diff(
        DateTime.fromISO(cleanupStartTime),
        "hours",
      ).hours;
      const isStale = hoursElapsed >= 24;

      const isCoolingDown = activeCleanup?.status === "COOLING_DOWN";
      let message: string;

      if (isCoolingDown) {
        message =
          "Account is in post-cleanup cooldown to allow cost data to settle. " +
          "View account details for the precise countdown.";
      } else if (isStale) {
        message = "The cleanup process may be stuck, please retry.";
      } else {
        message =
          "This account is being cleaned up and will be ready to use soon.";
      }

      const color =
        isStale && !isCoolingDown ? colorChartsStatusHigh : getColor(status);

      return (
        <Popover
          position="top"
          size="large"
          dismissButton={false}
          content={
            <div style={{ color }}>
              {message}
              <Box color={"inherit"} fontWeight={"heavy"}>
                Cleanup initiated:{` ${DateTime.fromISO(cleanupStartTime)}`}
              </Box>
            </div>
          }
        >
          <span
            style={{
              color,
            }}
          >
            <Icon name="remove" /> {cleanupLabel}
          </span>
        </Popover>
      );
    }

    case "Quarantine":
      return (
        <span style={{ color: getColor(status) }}>
          <Icon name="status-negative" /> Quarantine
        </span>
      );

    default:
      return null;
  }
};
