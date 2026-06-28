// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  Container,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useNavigate } from "react-router-dom";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import {
  useGetPendingApprovals,
  useGetPendingExtensions,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";

export const ApprovalsPanel = () => {
  const navigate = useNavigate();
  const {
    data: approvals,
    isFetching,
    isError,
    refetch,
    error,
  } = useGetPendingApprovals();
  const {
    data: extensions,
    isFetching: isFetchingExtensions,
    isError: isErrorExtensions,
    refetch: refetchExtensions,
    error: extensionError,
  } = useGetPendingExtensions();

  const totalPending = (approvals?.length ?? 0) + (extensions?.length ?? 0);
  const isLoading = isFetching || isFetchingExtensions;
  const hasError = isError || isErrorExtensions;

  const body = () => {
    if (isLoading) {
      return (
        <Container>
          <Loader label="Checking for approval requests..." />
        </Container>
      );
    }

    if (hasError) {
      return (
        <ErrorPanel
          description="Approvals could not be loaded."
          retry={() => {
            refetch();
            refetchExtensions();
          }}
          error={(error || extensionError) as Error}
        />
      );
    }

    if (totalPending === 0) {
      return (
        <Alert type="success">No pending approvals. Nothing to review.</Alert>
      );
    }

    return (
      <Alert type="warning" header="Pending approvals">
        <Box margin={{ top: "xs" }}>
          {totalPending === 1 ? (
            <>
              There is <strong>1</strong> pending approval.
            </>
          ) : (
            <>
              There are <strong>{totalPending} pending approvals.</strong>
            </>
          )}
        </Box>
        <Box margin={{ top: "s" }}>
          <Button onClick={() => navigate("/approvals")}>View approvals</Button>
        </Box>
      </Alert>
    );
  };

  return (
    <SpaceBetween size="m">
      <Header
        variant="h2"
        actions={
          <Button
            iconName="refresh"
            ariaLabel="Refresh"
            disabled={isLoading}
            onClick={() => {
              refetch();
              refetchExtensions();
            }}
          />
        }
      >
        Approvals
      </Header>
      {body()}
    </SpaceBetween>
  );
};
