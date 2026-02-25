// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Button,
  Container,
  Header,
  KeyValuePairs,
  RadioGroupProps,
  SpaceBetween,
} from "@cloudscape-design/components";

import {
  ConcurrencyMode,
  DeploymentStrategy,
  StackSet,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";

interface BlueprintSummaryProps {
  blueprint: {
    name: string;
    tags?: { key: string; value?: string }[];
    selectedStackSet: StackSet | undefined;
    selectedRegions: string[];
    deploymentTimeout: number;
    deploymentStrategy: DeploymentStrategy;
    regionConcurrencyType: RadioGroupProps.RadioButtonDefinition;
    maxConcurrentPercentage: number;
    failureTolerancePercentage: number;
    concurrencyMode: ConcurrencyMode;
  };
  showEditButtons?: boolean;
  onEditBasic?: () => void;
  onEditStackSet?: () => void;
  onEditDeployment?: () => void;
}

export const BlueprintSummary = ({
  blueprint,
  showEditButtons = false,
  onEditBasic,
  onEditStackSet,
  onEditDeployment,
}: BlueprintSummaryProps) => {
  const getStrategyDisplayName = (strategy: string) => {
    const names = {
      Default: "Default",
      Custom: "Custom",
    };
    return names[strategy as keyof typeof names] || strategy;
  };

  const getConcurrencyModeDisplayName = (mode: ConcurrencyMode): string => {
    return mode === "STRICT_FAILURE_TOLERANCE" ? "Strict" : "Soft";
  };

  const blueprintDetailsItems = [
    { label: "Name", value: blueprint.name },
    ...(blueprint.tags && blueprint.tags.length > 0
      ? [
          {
            label: "Tags",
            value: blueprint.tags
              .filter((tag) => tag.key)
              .map((tag) => (tag.value ? `${tag.key}: ${tag.value}` : tag.key))
              .join(", "),
          },
        ]
      : []),
  ];

  const stackSetItems = [
    {
      label: "StackSet Name",
      value: blueprint.selectedStackSet?.stackSetName || "-",
    },
    {
      label: "StackSet ID",
      value: blueprint.selectedStackSet?.stackSetId || "-",
    },
    ...(blueprint.selectedStackSet?.description
      ? [
          {
            label: "Description",
            value: blueprint.selectedStackSet.description,
          },
        ]
      : []),
  ];

  const deploymentConfigItems: Array<{
    label: string;
    value: React.ReactNode;
  }> = [
    {
      label: "Regions",
      value: blueprint.selectedRegions.join(", ") || "-",
    },
    {
      label: "Deployment strategy",
      value: getStrategyDisplayName(blueprint.deploymentStrategy),
    },
  ];

  if (blueprint.deploymentStrategy === "Custom") {
    deploymentConfigItems.push(
      {
        label: "Region concurrency type",
        value: blueprint.regionConcurrencyType.label,
      },
      {
        label: "Concurrent deployments",
        value: `${blueprint.maxConcurrentPercentage}%`,
      },
      {
        label: "Failure tolerance",
        value: `${blueprint.failureTolerancePercentage}%`,
      },
      {
        label: "Concurrency mode",
        value: getConcurrencyModeDisplayName(blueprint.concurrencyMode),
      },
    );
  }

  deploymentConfigItems.push({
    label: "Deployment timeout",
    value: `${blueprint.deploymentTimeout} minutes`,
  });

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditBasic ? (
                <Button onClick={onEditBasic}>Edit</Button>
              ) : undefined
            }
          >
            Blueprint details
          </Header>
        }
      >
        <KeyValuePairs columns={2} items={blueprintDetailsItems} />
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditStackSet ? (
                <Button onClick={onEditStackSet}>Edit</Button>
              ) : undefined
            }
          >
            StackSet
          </Header>
        }
      >
        <KeyValuePairs columns={2} items={stackSetItems} />
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditDeployment ? (
                <Button onClick={onEditDeployment}>Edit</Button>
              ) : undefined
            }
          >
            Deployment settings
          </Header>
        }
      >
        <KeyValuePairs columns={2} items={deploymentConfigItems} />
      </Container>
    </SpaceBetween>
  );
};
