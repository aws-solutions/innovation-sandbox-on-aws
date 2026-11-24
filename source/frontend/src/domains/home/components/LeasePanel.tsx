// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Badge,
  Button,
  ColumnLayout,
  Container,
  Header,
  KeyValuePairs,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useNavigate } from "react-router-dom";

import { AccountId } from "@amzn/innovation-sandbox-frontend/components/AccountId";
import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import { LeaseName } from "@amzn/innovation-sandbox-frontend/components/LeaseName";
import { LeaseTemplateName } from "@amzn/innovation-sandbox-frontend/components/LeaseTemplateName";
import { LeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseActions";
import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import { isLeaseOwner } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { useLeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/useLeaseActions";
import {
  isSandboxSpaceAssignee,
  isSandboxSpaceAvailable,
  isSandboxSpacesGloballyUsable,
  SANDBOX_SPACE_ASSIGNEE_ONLY_REASON,
  sandboxSpacePath,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import {
  getCurrentLeaseSpend,
  isExpiredLease,
  isMonitoredLease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

interface LeasePanelProps {
  lease: LeaseView;
}

export const LeasePanel = ({ lease }: LeasePanelProps) => {
  const { hasAnyAction } = useLeaseActions(lease);
  const { user } = useUser();
  const navigate = useNavigate();
  const { data: config } = useGetConfigurations();
  const isOwner = isLeaseOwner(lease, user);
  const showOpenSpaceAction =
    isSandboxSpaceAvailable(lease) &&
    isSandboxSpacesGloballyUsable(config?.agent.sandboxSpacesEnabled);
  const isAssignee = isSandboxSpaceAssignee(lease, user);

  return (
    <Container data-shadow>
      <SpaceBetween size="l">
        <Header
          variant="h3"
          actions={
            showOpenSpaceAction || hasAnyAction ? (
              <SpaceBetween direction="horizontal" size="xs">
                {showOpenSpaceAction && (
                  <Button
                    iconName="gen-ai"
                    disabled={!isAssignee}
                    {...(isAssignee
                      ? {}
                      : { disabledReason: SANDBOX_SPACE_ASSIGNEE_ONLY_REASON })}
                    onClick={() => navigate(sandboxSpacePath(lease.leaseId))}
                  >
                    Open Space
                  </Button>
                )}
                {hasAnyAction && <LeaseActions lease={lease} />}
              </SpaceBetween>
            ) : undefined
          }
        >
          <LeaseName
            uuid={lease.uuid}
            templateName={lease.originalLeaseTemplateName}
            leaseId={lease.leaseId}
            fontSize="heading-m"
          />
        </Header>
        <ColumnLayout columns={3} variant="text-grid">
          <KeyValuePairs
            items={[
              { label: "Status", value: <LeaseStatusBadge lease={lease} /> },
              {
                label: "Owner",
                value: (
                  <SpaceBetween direction="horizontal" size="xs">
                    <span>{lease.userEmail}</span>
                    {isOwner ? (
                      <Badge>You</Badge>
                    ) : (
                      <Badge color="blue">Shared</Badge>
                    )}
                  </SpaceBetween>
                ),
              },
            ]}
          />
          <KeyValuePairs
            items={[
              {
                label: "Lease Template",
                value: (
                  <LeaseTemplateName
                    name={lease.originalLeaseTemplateName}
                    uuid={lease.originalLeaseTemplateUuid}
                  />
                ),
              },
              {
                label: "AWS Account",
                value: (
                  <AccountId
                    accountId={
                      isMonitoredLease(lease) ? lease.awsAccountId : undefined
                    }
                    copyable
                    emptyText={`No account assigned${lease.status === "PendingApproval" ? " yet" : ""}`}
                  />
                ),
              },
            ]}
          />
          <KeyValuePairs
            items={[
              {
                label: "Expiry",
                value: <DurationStatus {...getLeaseExpiryInfo(lease)} />,
              },
              {
                label: "Budget",
                value: (
                  <BudgetProgressBar
                    currentValue={
                      isMonitoredLease(lease) || isExpiredLease(lease)
                        ? getCurrentLeaseSpend(lease)
                        : 0
                    }
                    maxValue={lease.maxSpend}
                  />
                ),
              },
            ]}
          />
        </ColumnLayout>
      </SpaceBetween>
    </Container>
  );
};
