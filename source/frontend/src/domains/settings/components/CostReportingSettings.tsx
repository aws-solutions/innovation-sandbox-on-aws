// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { KeyValuePairs, StatusIndicator } from "@cloudscape-design/components";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { SettingsContainer } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsContainer";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";

export const CostReportingSettings = () => {
  const {
    data: config,
    isLoading,
    isError: loadingError,
    refetch,
    error,
  } = useGetConfigurations();

  if (isLoading) {
    return <Loader />;
  }

  if (loadingError || !config) {
    return (
      <ErrorPanel
        description="There was a problem loading settings."
        retry={refetch}
        error={error as Error}
      />
    );
  }

  return (
    <SettingsContainer>
      <KeyValuePairs
        items={[
          {
            label: "Require Cost Report Groups",
            value: config.requireCostReportGroup ? (
              <>Cost report group is required</>
            ) : (
              <>Cost report group is not required</>
            ),
          },
          {
            label: "Cost Report Groups",
            value:
              (config.costReportGroups || []).length > 0 ? (
                <ul data-list>
                  {config.costReportGroups.map((group) => (
                    <li key={group}>{group}</li>
                  ))}
                </ul>
              ) : (
                <StatusIndicator type="warning">Not set</StatusIndicator>
              ),
          },
        ]}
      />
    </SettingsContainer>
  );
};
