// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Container,
  KeyValuePairs,
  StatusIndicator,
} from "@cloudscape-design/components";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { SettingsContainer } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsContainer";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";

export const GeneralSettings = () => {
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
            label: "Maintenance Mode",
            value: config.maintenanceMode ? (
              <StatusIndicator type="warning">
                Maintenance mode is ON
              </StatusIndicator>
            ) : (
              <StatusIndicator type="success">
                Maintenance mode is OFF
              </StatusIndicator>
            ),
          },
          {
            label: "Innovation Sandbox Managed Regions",
            value:
              (config.isbManagedRegions || []).length > 0 ? (
                <ul data-list>
                  {config.isbManagedRegions.map((region) => (
                    <li key={region}>{region}</li>
                  ))}
                </ul>
              ) : (
                <StatusIndicator type="warning">Not set</StatusIndicator>
              ),
          },
          {
            label: "Terms of Service",
            value: (
              <Container>
                <Box
                  variant="pre"
                  nativeAttributes={{ style: { textWrap: "auto" } }}
                >
                  {config.termsOfService}
                </Box>
              </Container>
            ),
          },
        ]}
      />
    </SettingsContainer>
  );
};
