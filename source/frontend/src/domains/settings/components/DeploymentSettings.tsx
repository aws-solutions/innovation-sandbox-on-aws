// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Badge,
  Box,
  Container,
  Header,
  KeyValuePairs,
  Link,
  SpaceBetween,
} from "@cloudscape-design/components";

import {
  AdminConfigurationView,
  DeployTimeConfigurationView,
} from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { formSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";

const fields = {
  version: {
    label: "Solution version",
  },
  awsAccessPortalUrl: {
    label: "AWS access portal URL",
  },
  isbManagedRegions: {
    label: "Innovation Sandbox managed regions",
  },
  bedrockInferenceProfilePatterns: {
    label: "Bedrock inference profile patterns",
  },
} satisfies Record<
  keyof DeployTimeConfigurationView | "version",
  { label: string }
>;

export const deploymentSettingsSearchFields = formSearchFields({
  group: "general",
  subgroup: "Deployment settings",
  description: "Read-only configuration set at deployment time.",
  fields,
});

export const DeploymentSettings = ({
  config,
}: Readonly<{ config: AdminConfigurationView }>) => {
  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Configured at deployment time and cannot be changed here."
        >
          Deployment settings
        </Header>
      }
    >
      <KeyValuePairs
        columns={2}
        items={[
          {
            label: fields.version.label,
            value: (
              <Box
                nativeAttributes={{
                  id: "version" satisfies keyof typeof fields,
                  tabIndex: -1,
                }}
              >
                {SOLUTION_VERSION}
              </Box>
            ),
          },
          {
            label: fields.awsAccessPortalUrl.label,
            value: (
              <Box
                nativeAttributes={{
                  id: "awsAccessPortalUrl" satisfies keyof typeof fields,
                  tabIndex: -1,
                }}
              >
                {config.awsAccessPortalUrl ? (
                  <Link external href={config.awsAccessPortalUrl}>
                    {config.awsAccessPortalUrl}
                  </Link>
                ) : (
                  "(not set)"
                )}
              </Box>
            ),
          },
          {
            label: fields.isbManagedRegions.label,
            value: (
              <Box
                nativeAttributes={{
                  id: "isbManagedRegions" satisfies keyof typeof fields,
                  tabIndex: -1,
                }}
              >
                {config.isbManagedRegions.length ? (
                  <SpaceBetween direction="horizontal" size="xs">
                    {config.isbManagedRegions.map((region) => (
                      <Badge key={region}>{region}</Badge>
                    ))}
                  </SpaceBetween>
                ) : (
                  "(none)"
                )}
              </Box>
            ),
          },
          {
            label: fields.bedrockInferenceProfilePatterns.label,
            value: (
              <Box
                nativeAttributes={{
                  id: "bedrockInferenceProfilePatterns" satisfies keyof typeof fields,
                  tabIndex: -1,
                }}
              >
                {config.bedrockInferenceProfilePatterns.length > 0
                  ? config.bedrockInferenceProfilePatterns.join(", ")
                  : "Not configured"}
              </Box>
            ),
          },
        ]}
      />
    </Container>
  );
};
