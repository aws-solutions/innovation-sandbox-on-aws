// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@cloudscape-design/components";

import { Lease } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { getLeaseStatusDisplayName } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";

const getBadgeColor = (status: string) => {
  if (status === "Active") {
    return "green";
  }

  if (status === "Frozen") {
    return "blue";
  }

  if (status === "PendingApproval") {
    return "severity-low";
  }

  if (status === "Provisioning") {
    return "blue";
  }

  // everything else is red
  return "red";
};

export const LeaseStatusBadge = ({ lease }: { lease: Lease }) => {
  return (
    <Badge color={getBadgeColor(lease.status)} data-badge>
      {getLeaseStatusDisplayName(lease.status)}
    </Badge>
  );
};
