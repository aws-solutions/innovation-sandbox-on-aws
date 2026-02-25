// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button, Header, SpaceBetween } from "@cloudscape-design/components";
import { useNavigate } from "react-router-dom";

import {
  isApprovalDeniedLease,
  isExpiredLease,
  isMonitoredLease,
  isPendingLease,
  LeaseWithLeaseId,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { InfoPanel } from "@amzn/innovation-sandbox-frontend/components/InfoPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { LeasePanel } from "@amzn/innovation-sandbox-frontend/domains/home/components/LeasePanel";
import { useLeasesForCurrentUser } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { DateTime } from "luxon";
import { useMemo } from "react";

const DAYS_OF_LEASE_HISTORY = 7;

export const MyLeases = () => {
  const navigate = useNavigate();
  const {
    data: leases,
    isFetching,
    isError,
    refetch,
    error,
  } = useLeasesForCurrentUser();

  const shouldIncludeLease = (lease: LeaseWithLeaseId): boolean => {
    if (isApprovalDeniedLease(lease)) {
      if (!lease.meta?.lastEditTime) {
        return false;
      }
      return (
        DateTime.now().diff(DateTime.fromISO(lease.meta?.lastEditTime), "days")
          .days <= DAYS_OF_LEASE_HISTORY
      );
    } else if (isExpiredLease(lease)) {
      return (
        DateTime.now().diff(DateTime.fromISO(lease.endDate), "days").days <=
        DAYS_OF_LEASE_HISTORY
      );
    } else {
      return true;
    }
  };

  const getStatusPriority = (lease: LeaseWithLeaseId): number => {
    if (isMonitoredLease(lease)) return 1;
    if (isPendingLease(lease)) return 2;
    return 3;
  };

  const compareLeaseDates = (dateA?: string, dateB?: string): number => {
    if (!dateA || !dateB) return 0;
    return (
      DateTime.fromISO(dateB).toMillis() - DateTime.fromISO(dateA).toMillis()
    );
  };

  const filteredLeases = useMemo(() => {
    return leases?.filter(shouldIncludeLease).sort((a, b) => {
      const priorityDiff = getStatusPriority(a) - getStatusPriority(b);
      return priorityDiff !== 0
        ? priorityDiff
        : compareLeaseDates(a.meta?.lastEditTime, b.meta?.lastEditTime);
    });
  }, [leases]);

  // Render body content based on loading/error/data state
  let bodyContent: React.JSX.Element;
  if (isFetching) {
    bodyContent = <Loader label="Loading your leases..." />;
  } else if (isError) {
    bodyContent = (
      <ErrorPanel
        description="Your leases can't be retrieved at the moment."
        retry={refetch}
        error={error as Error}
      />
    );
  } else if ((filteredLeases || []).length === 0) {
    bodyContent = (
      <InfoPanel
        header="You currently don't have any leases."
        description="To get started, click below to request a new lease."
        actionLabel="Request lease"
        action={() => navigate("/request")}
      />
    );
  } else {
    bodyContent = (
      <SpaceBetween size="xl">
        {filteredLeases?.map((lease) => (
          <LeasePanel key={lease.uuid} lease={lease} />
        ))}
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="m">
      <Header
        variant="h2"
        description="View a list of your leases"
        actions={
          <Button
            iconName="refresh"
            ariaLabel="Refresh"
            disabled={isFetching}
            onClick={() => refetch()}
          />
        }
      >
        My Leases{" "}
        {!isFetching && !isError && (
          <span data-counter>({(filteredLeases || []).length})</span>
        )}
      </Header>
      {bodyContent}
    </SpaceBetween>
  );
};
