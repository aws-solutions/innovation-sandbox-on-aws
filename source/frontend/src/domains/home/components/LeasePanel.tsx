// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  ColumnLayout,
  Container,
  FormField,
  Header,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import {
  isExpiredLease,
  isMonitoredLease,
  LeaseWithLeaseId,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";
import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { Divider } from "@amzn/innovation-sandbox-frontend/components/Divider";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";

interface LeasePanelProps {
  lease: LeaseWithLeaseId;
}

export const LeasePanel = ({ lease }: LeasePanelProps) => {
  return (
    <Container data-shadow>
      <SpaceBetween size="l">
        <Header
          variant="h3"
          actions={
            <>
              {lease.status === "Active" && (
                <AccountLoginLink
                  accountId={lease.awsAccountId}
                  variant="normal"
                />
              )}

              {lease.status === "PendingApproval" && (
                <StatusIndicator type="info">
                  Your account is pending approval
                </StatusIndicator>
              )}
            </>
          }
          description={<LeaseStatusBadge lease={lease} />}
        >
          {lease.originalLeaseTemplateName || `Lease ${lease.uuid}`}
        </Header>
        <Divider marginBottom="s" />
        <ColumnLayout columns={4} variant="text-grid">
          <Box>
            <FormField label="AWS Account ID" />
            {isMonitoredLease(lease) ? (
              lease.awsAccountId
            ) : (
              <StatusIndicator type="warning">
                No account assigned{" "}
                {lease.status === "PendingApproval" && "yet"}
              </StatusIndicator>
            )}
          </Box>

          <Box>
            <FormField label="Expiry" />
            <DurationStatus {...getLeaseExpiryInfo(lease)} />
          </Box>

          <Box>
            <FormField label="Budget" />
            <SpaceBetween size="m">
              <BudgetProgressBar
                currentValue={
                  isMonitoredLease(lease) || isExpiredLease(lease)
                    ? lease.totalCostAccrued
                    : 0
                }
                maxValue={lease.maxSpend}
              />
            </SpaceBetween>
          </Box>
        </ColumnLayout>
      </SpaceBetween>
    </Container>
  );
};
