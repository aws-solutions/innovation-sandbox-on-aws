// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Badge,
  KeyValuePairs,
  List,
  StatusIndicator,
} from "@cloudscape-design/components";

interface ThresholdDetailsProps {
  thresholds:
    | Array<{
        action: "ALERT" | "FREEZE_ACCOUNT";
        triggerOn?: "REPORTED" | "PREDICTED";
      }>
    | undefined;
  renderValue: (threshold: any) => React.ReactNode;
  valueLabel: string;
  /**
   * Show each threshold's trigger figure (budget thresholds only). A threshold
   * without triggerOn reads as reported cost, today's behavior.
   */
  showTriggerOn?: boolean;
}

export const ThresholdDetails = ({
  thresholds,
  renderValue,
  valueLabel,
  showTriggerOn = false,
}: ThresholdDetailsProps) => {
  const formatAction = (action: string) => {
    return action === "ALERT" ? "Send alert" : "Freeze lease";
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
            columns={showTriggerOn ? 4 : 3}
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
              ...(showTriggerOn
                ? [
                    {
                      label: "Cost basis",
                      value:
                        threshold.triggerOn === "PREDICTED"
                          ? "Estimated cost"
                          : "Reported cost",
                    },
                  ]
                : []),
            ]}
          />
        ),
      }))}
    />
  );
};
