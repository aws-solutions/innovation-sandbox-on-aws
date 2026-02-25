// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Container,
  Header,
  KeyValuePairs,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
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

export const ReviewForm = (props: ReviewStepProps) => {
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
        <Container header={<Header variant="h2">Assignment Details</Header>}>
          <KeyValuePairs items={[{ label: "Target User", value: userEmail }]} />
        </Container>
      )}

      {/* Lease Template Information */}
      <Container header={<Header variant="h2">Lease Template Selected</Header>}>
        <KeyValuePairs
          items={[
            { label: "Name", value: leaseTemplate.name },
            { label: "Description", value: leaseTemplate.description },
            {
              label: "Blueprint",
              value: (
                <BlueprintName blueprintName={leaseTemplate.blueprintName} />
              ),
            },
            {
              label: "Duration",
              value: (
                <DurationStatus
                  durationInHours={leaseTemplate.leaseDurationInHours}
                />
              ),
            },
            {
              label: "Max Budget",
              value: <BudgetStatus maxSpend={leaseTemplate.maxSpend} />,
            },
            { label: "Approval", value: renderApprovalStatus() },
          ]}
        />
      </Container>
    </SpaceBetween>
  );
};
