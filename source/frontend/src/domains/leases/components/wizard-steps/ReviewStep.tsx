// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { KeyValuePair } from "@aws-northstar/ui";
import {
  Alert,
  Box,
  Container,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import { BudgetStatus } from "@amzn/innovation-sandbox-frontend/components/BudgetStatus";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { useGetLeaseTemplateById } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";

type ReviewStepProps = {
  data: {
    leaseTemplateUuid: string;
    userEmail?: string;
  };
};

export const ReviewStep = (props: ReviewStepProps) => {
  const {
    data: leaseTemplate,
    isLoading,
    isError,
    error,
  } = useGetLeaseTemplateById(props.data.leaseTemplateUuid);

  if (isLoading) {
    return <Loader data-testid="loader" />;
  }

  if (isError) {
    return (
      <Alert type="error">
        Error loading lease template:{" "}
        {error instanceof Error ? error.message : "Unknown error"}
      </Alert>
    );
  }

  if (!leaseTemplate) {
    return null;
  }

  const { userEmail } = props.data;

  const renderApprovalStatus = () => {
    if (userEmail) {
      return (
        <StatusIndicator type="success">
          Direct assignment - No approval required
        </StatusIndicator>
      );
    }

    if (leaseTemplate.requiresApproval) {
      return (
        <StatusIndicator type="warning">Requires approval</StatusIndicator>
      );
    }

    return (
      <StatusIndicator type="success">No approval required</StatusIndicator>
    );
  };

  return (
    <SpaceBetween size="s">
      {userEmail && (
        <KeyValuePair
          label="Assignment Details"
          value={
            <Box margin={{ top: "xs" }}>
              <Container>
                <SpaceBetween size="xs">
                  <Box>
                    <StatusIndicator type="info">
                      Creating lease for: <strong>{userEmail}</strong>
                    </StatusIndicator>
                  </Box>
                  <Box data-muted>
                    <small>
                      This lease will be assigned directly to the specified user
                      without requiring approval.
                    </small>
                  </Box>
                </SpaceBetween>
              </Container>
            </Box>
          }
        />
      )}

      {/* Lease Template Information */}
      <KeyValuePair
        label="Lease Template Selected"
        value={
          <Box margin={{ top: "xs" }}>
            <Container>
              <SpaceBetween size="xs">
                <Box>
                  <Box>
                    <strong>{leaseTemplate.name}</strong>
                  </Box>
                  <Box>
                    <small>{leaseTemplate.description}</small>
                  </Box>
                </Box>

                <Box data-muted>
                  <strong>Expires: </strong>
                  <DurationStatus
                    durationInHours={leaseTemplate.leaseDurationInHours}
                  />
                </Box>
                <Box data-muted>
                  <strong>Max budget: </strong>
                  <BudgetStatus maxSpend={leaseTemplate.maxSpend} />
                </Box>
                <Box>{renderApprovalStatus()}</Box>
              </SpaceBetween>
            </Container>
          </Box>
        }
      />
    </SpaceBetween>
  );
};
