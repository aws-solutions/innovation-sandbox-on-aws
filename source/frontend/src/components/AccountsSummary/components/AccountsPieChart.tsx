// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PieChart } from "@cloudscape-design/components";
import { useMemo } from "react";

import { convertAccountsToSummary } from "@amzn/innovation-sandbox-frontend/components/AccountsSummary/helpers";
import { SandboxAccountView } from "@amzn/innovation-sandbox-frontend/domains/accounts/model";

interface AccountsPieChartProps {
  accounts: SandboxAccountView[];
}

export const AccountsPieChart = ({ accounts }: AccountsPieChartProps) => {
  const summary = useMemo(() => {
    return convertAccountsToSummary(accounts).filter((item) => item.value > 0);
  }, [accounts]);

  return (
    <PieChart
      data={summary}
      variant="donut"
      segmentDescription={(datum, sum) =>
        `${datum.value} accounts, ${((datum.value / sum) * 100).toFixed(0)}%`
      }
      hideFilter={true}
      hideLegend
    />
  );
};
