// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Badge,
  KeyValuePairs,
  List,
  StatusIndicator,
} from "@cloudscape-design/components";

interface ThresholdDetailsProps {
  thresholds: Array<{ action: "ALERT" | "FREEZE_ACCOUNT" }> | undefined;
  renderValue: (threshold: any) => React.ReactNode;
  valueLabel: string;
}

export const ThresholdDetails = ({
  thresholds,
  renderValue,
  valueLabel,
}: ThresholdDetailsProps) => {
  const formatAction = (action: string) => {
    return action === "ALERT" ? "Alert" : "Freeze";
  };

  if (!thresholds || thresholds.length === 0) {
    return (
      <StatusIndicator type="info">No thresholds configured</StatusIndicator>
    );
  }

  return (
    <List
      renderItem={(item) => item}
      items={thresholds.map((threshold, index) => ({
        id: `${index}`,
        content: (
          <KeyValuePairs
            columns={3}
            minColumnWidth={100}
            items={[
              {
                label: "Threshold",
                value: index + 1,
              },
              {
                label: valueLabel,
                value: renderValue(threshold),
              },
              {
                label: "Action",
                value: (
                  <Badge color={threshold.action === "ALERT" ? "grey" : "blue"}>
                    {formatAction(threshold.action)}
                  </Badge>
                ),
              },
            ]}
          />
        ),
      }))}
    />
  );
};
