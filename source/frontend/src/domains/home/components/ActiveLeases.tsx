// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button, Header, SpaceBetween } from "@cloudscape-design/components";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { InfoPanel } from "@amzn/innovation-sandbox-frontend/components/InfoPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { LeasePanel } from "@amzn/innovation-sandbox-frontend/domains/home/components/LeasePanel";
import {
  useGetSharedLeases,
  useLeasesForCurrentUser,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { LeaseStatus } from "@amzn/innovation-sandbox-shared/types/lease.js";

const ACTIVE_STATUSES = new Set<LeaseStatus>([
  "PendingApproval",
  "Active",
  "Frozen",
  "Provisioning",
]);

/**
 * Unified Home page section showing all active leases the user can access
 * (both owned and shared), with an ownership indicator on each card.
 */
export const ActiveLeases = () => {
  const navigate = useNavigate();

  const {
    data: myLeases,
    isLoading: isMyLoading,
    isError: isMyError,
    refetch: refetchMy,
    error: myError,
  } = useLeasesForCurrentUser();

  const {
    data: directData,
    isLoading: isDirectLoading,
    isError: isDirectError,
    refetch: refetchDirect,
    error: directError,
  } = useGetSharedLeases("direct");

  const {
    data: groupData,
    isLoading: isGroupLoading,
    isError: isGroupError,
    refetch: refetchGroup,
    error: groupError,
  } = useGetSharedLeases("group");

  const isLoading = isMyLoading || isDirectLoading || isGroupLoading;
  const isError = isMyError || isDirectError || isGroupError;
  const firstError = (myError ?? directError ?? groupError) as Error;

  const refetch = useCallback(() => {
    refetchMy();
    refetchDirect();
    refetchGroup();
  }, [refetchMy, refetchDirect, refetchGroup]);

  const directResults = directData?.result;
  const groupResults = groupData?.result;

  const activeLeases: LeaseView[] = useMemo(() => {
    // Owned first, then direct, then group — first occurrence wins dedup
    const all = [
      ...(myLeases ?? []),
      ...(directResults ?? []),
      ...(groupResults ?? []),
    ];

    const seen = new Set<string>();
    return all.filter((lease) => {
      if (seen.has(lease.leaseId)) return false;
      if (!ACTIVE_STATUSES.has(lease.status)) return false;
      seen.add(lease.leaseId);
      return true;
    });
  }, [myLeases, directResults, groupResults]);

  const renderBody = () => {
    if (isLoading) {
      return <Loader label="Loading leases..." />;
    }

    if (isError) {
      return (
        <ErrorPanel
          description="Your leases can't be retrieved at the moment."
          retry={refetch}
          error={firstError}
        />
      );
    }

    if (activeLeases.length === 0) {
      return (
        <InfoPanel
          header="You currently don't have any active leases."
          description="To get started, click below to request a new lease."
          actionLabel="Request lease"
          action={() => navigate("/request")}
        />
      );
    }

    return (
      <SpaceBetween size="xl">
        {activeLeases.map((lease) => (
          <LeasePanel key={lease.leaseId} lease={lease} />
        ))}
      </SpaceBetween>
    );
  };

  return (
    <SpaceBetween size="m">
      <Header
        variant="h2"
        description="Current sandbox leases you own or that are shared with you"
        counter={
          !isLoading && !isError ? `(${activeLeases.length})` : undefined
        }
        actions={
          <Button
            iconName="refresh"
            ariaLabel="Refresh"
            disabled={isLoading}
            onClick={refetch}
          />
        }
      >
        Active Leases
      </Header>
      {renderBody()}
    </SpaceBetween>
  );
};
