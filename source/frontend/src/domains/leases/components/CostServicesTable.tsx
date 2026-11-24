// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Header, Table } from "@cloudscape-design/components";

import { CurrentServiceEntry } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { formatCostAmount } from "@amzn/innovation-sandbox-frontend/helpers/cost-formatting";

import { formatChangePercent, formatShare } from "./cost-history-helpers";

type CostServicesTableProps = {
  services: CurrentServiceEntry[];
};

export const CostServicesTable = ({ services }: CostServicesTableProps) => {
  const billedServices = services.filter((entry) => entry.amount !== 0);
  return (
    <Table<CurrentServiceEntry>
      variant="container"
      header={
        <Header
          counter={`(${billedServices.length})`}
          description="Ranked by cost at the last reading. Change compares that reading with the one before it, across the pages loaded so far."
        >
          Top services
        </Header>
      }
      columnDefinitions={[
        {
          id: "service",
          header: "Service",
          cell: (entry) => entry.service,
        },
        {
          id: "cost",
          header: "Cost",
          cell: (entry) => formatCostAmount(entry.amount),
        },
        {
          id: "share",
          header: "Share",
          cell: (entry) =>
            entry.amount > 0 && entry.shareOfBilledCost === 0
              ? "< 1%"
              : formatShare(entry.shareOfBilledCost),
        },
        {
          id: "change",
          header: "Change",
          cell: (entry) =>
            entry.changePercent == null
              ? "—"
              : formatChangePercent(entry.changePercent),
        },
      ]}
      items={billedServices}
      trackBy={(entry) => entry.service}
      empty={
        <Box textAlign="center" color="inherit">
          <Box variant="strong">No service breakdown available</Box>
          <Box variant="p">
            Either this deployment records no per-service breakdown for the
            lease, or the billed total could not be attributed to services. This
            is not a report of zero spend — read the billed total above.
          </Box>
        </Box>
      }
    />
  );
};
