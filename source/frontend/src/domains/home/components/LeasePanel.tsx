// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  ButtonDropdown,
  ColumnLayout,
  Container,
  FormField,
  Header,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";
import { useState } from "react";

import {
  isExpiredLease,
  isMonitoredLease,
  LeaseWithLeaseId,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";
import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { Divider } from "@amzn/innovation-sandbox-frontend/components/Divider";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import { RequestExtensionModal } from "@amzn/innovation-sandbox-frontend/domains/leases/components/RequestExtensionModal";
import { useTerminateLease } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { MonitoredLeaseWithLeaseId } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

interface LeasePanelProps {
  lease: LeaseWithLeaseId;
}

export const LeasePanel = ({ lease }: LeasePanelProps) => {
  const { showModal, hideModal } = useModal();
  const { mutateAsync: terminateLease, isPending: isTerminating } =
    useTerminateLease();
  const { data: config } = useGetConfigurations();
  const [showTerminateConfirm, setShowTerminateConfirm] = useState(false);

  const isActiveOrFrozen =
    lease.status === "Active" || lease.status === "Frozen";

  const handleRequestExtension = () => {
    if (!isMonitoredLease(lease)) return;

    showModal({
      header: "Request Lease Extension",
      content: (
        <RequestExtensionModal
          lease={lease as MonitoredLeaseWithLeaseId}
          maxDurationHours={config?.leases.maxDurationHours}
          onCancel={hideModal}
        />
      ),
    });
  };

  const handleTerminateLease = async () => {
    try {
      await terminateLease(lease.leaseId);
      showSuccessToast("Lease terminated successfully.");
    } catch (error) {
      if (error instanceof Error) {
        showErrorToast(error.message, "Terminate Lease Failed");
      } else {
        showErrorToast(
          "An unexpected error occurred while terminating the lease.",
          "Terminate Lease Failed",
        );
      }
    }
    setShowTerminateConfirm(false);
  };

  return (
    <Container data-shadow>
      <SpaceBetween size="l">
        <Header
          variant="h3"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
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

              {isActiveOrFrozen && (
                <ButtonDropdown
                  items={[
                    {
                      text: "Terminate Lease",
                      id: "terminate",
                    },
                    {
                      text: "Request Extension",
                      id: "request-extension",
                    },
                  ]}
                  onItemClick={({ detail }) => {
                    switch (detail.id) {
                      case "terminate":
                        setShowTerminateConfirm(true);
                        break;
                      case "request-extension":
                        handleRequestExtension();
                        break;
                    }
                  }}
                  loading={isTerminating}
                >
                  Actions
                </ButtonDropdown>
              )}
            </SpaceBetween>
          }
          description={<LeaseStatusBadge lease={lease} />}
        >
          {lease.originalLeaseTemplateName || `Lease ${lease.uuid}`}
        </Header>

        {showTerminateConfirm && (
          <Box>
            <SpaceBetween size="s">
              <StatusIndicator type="warning">
                Are you sure you want to terminate this lease? This action
                cannot be undone.
              </StatusIndicator>
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => setShowTerminateConfirm(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={isTerminating}
                  onClick={handleTerminateLease}
                >
                  Confirm Terminate
                </Button>
              </SpaceBetween>
            </SpaceBetween>
          </Box>
        )}

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
