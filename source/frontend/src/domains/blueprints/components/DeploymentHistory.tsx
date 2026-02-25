// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Icon,
  Popover,
  SpaceBetween,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";

import { getDeploymentStatusConfig } from "@amzn/innovation-sandbox-frontend/domains/blueprints/helpers";
import { DeploymentHistory as DeploymentHistoryType } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";

interface DeploymentIndicatorProps {
  deployment: DeploymentHistoryType;
}

const DeploymentIndicator = ({ deployment }: DeploymentIndicatorProps) => {
  const config = getDeploymentStatusConfig(deployment.status);

  return (
    <Popover
      dismissButton={false}
      position="top"
      size="medium"
      triggerType="custom"
      content={
        <SpaceBetween size="xs">
          <Box key="status">
            <Box variant="awsui-key-label">Status</Box>
            <Box>{deployment.status}</Box>
          </Box>
          <Box key="started">
            <Box variant="awsui-key-label">Started</Box>
            <Box>
              {DateTime.fromISO(deployment.deploymentStartedAt).toLocaleString(
                DateTime.DATETIME_SHORT,
              )}
            </Box>
          </Box>
          {deployment.deploymentCompletedAt && (
            <Box key="completed">
              <Box variant="awsui-key-label">Completed</Box>
              <Box>
                {DateTime.fromISO(
                  deployment.deploymentCompletedAt,
                ).toLocaleString(DateTime.DATETIME_SHORT)}
              </Box>
            </Box>
          )}
          {deployment.duration && (
            <Box key="duration">
              <Box variant="awsui-key-label">Duration</Box>
              <Box>{deployment.duration} minutes</Box>
            </Box>
          )}
          {deployment.errorMessage && (
            <Box key="error">
              <Box variant="awsui-key-label">Error</Box>
              <Box color="text-status-error">{deployment.errorMessage}</Box>
            </Box>
          )}
          <Box key="account">
            <Box variant="awsui-key-label">Account</Box>
            <Box>{deployment.accountId}</Box>
          </Box>
          <Box key="lease">
            <Box variant="awsui-key-label">Lease</Box>
            <Box>{deployment.leaseId}</Box>
          </Box>
        </SpaceBetween>
      }
    >
      <Box color={config.color}>
        <Icon name={config.iconName} size="medium" />
      </Box>
    </Popover>
  );
};

interface DeploymentHistoryProps {
  deployments?: DeploymentHistoryType[];
}

export const DeploymentHistory = ({ deployments }: DeploymentHistoryProps) => {
  if (!deployments || deployments.length === 0) {
    return <Box>-</Box>;
  }

  const recentDeployments = deployments.slice(0, 10).reverse();

  return (
    <SpaceBetween direction="horizontal" size="xxs">
      {recentDeployments.map((deployment) => (
        <DeploymentIndicator
          key={deployment.operationId}
          deployment={deployment}
        />
      ))}
    </SpaceBetween>
  );
};
