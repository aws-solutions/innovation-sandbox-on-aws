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
import moment from "moment";
import { useMemo } from "react";

export const MyLeases = () => {
  const navigate = useNavigate();
  const {
    data: leases,
    isFetching,
    isError,
    refetch,
    error,
  } = useLeasesForCurrentUser();

  const filteredLeases = useMemo(() => {
    const DAYS_OF_LEASE_HISTORY = 7;
    return leases
      ?.filter((lease) => {
        if (isApprovalDeniedLease(lease)) {
          return (
            moment().diff(lease.meta?.lastEditTime, "days") <=
            DAYS_OF_LEASE_HISTORY
          );
        } else if (isExpiredLease(lease)) {
          return moment().diff(lease.endDate, "days") <= DAYS_OF_LEASE_HISTORY;
        } else {
          return true;
        }
      })
      .sort((a, b) => {
        // Helper function to get sort priority
        const getStatusPriority = (lease: LeaseWithLeaseId) => {
          if (isMonitoredLease(lease)) {
            return 1;
          } else if (isPendingLease(lease)) {
            return 2;
          } else {
            return 3;
          }
        };

        const priorityA = getStatusPriority(a);
        const priorityB = getStatusPriority(b);

        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }

        // If same priority, sort by date (newest first)
        const dateA = a.meta?.lastEditTime;
        const dateB = b.meta?.lastEditTime;

        return moment(dateB).valueOf() - moment(dateA).valueOf();
      });
  }, [leases]);

  const body = () => {
    if (isFetching) {
      return <Loader label="Loading your leases..." />;
    }

    if (isError) {
      return (
        <ErrorPanel
          description="Your leases can't be retrieved at the moment."
          retry={refetch}
          error={error as Error}
        />
      );
    }

    if ((filteredLeases || []).length === 0) {
      return (
        <InfoPanel
          header="You currently don't have any leases."
          description="To get started, click below to request a new lease."
          actionLabel="Request lease"
          action={() => navigate("/request")}
        />
      );
    }

    return (
      <SpaceBetween size="xl">
        {filteredLeases?.map((lease) => (
          <LeasePanel key={lease.uuid} lease={lease} />
        ))}
      </SpaceBetween>
    );
  };

  const count = () => {
    if (!isFetching && !isError) {
      return <span data-counter>({(filteredLeases || []).length})</span>;
    }
  };

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
        My Leases {count()}
      </Header>
      {body()}
    </SpaceBetween>
  );
};
