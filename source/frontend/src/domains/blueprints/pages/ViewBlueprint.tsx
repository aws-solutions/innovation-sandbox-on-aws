// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RegionConcurrencyType } from "@aws-sdk/client-cloudformation";
import {
  Button,
  ColumnLayout,
  Container,
  Header,
  KeyValuePairs,
  SpaceBetween,
  Table,
} from "@cloudscape-design/components";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { DeploymentHistoryTable } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/DeploymentHistoryTable";
import {
  extractStackSetNameFromId,
  formatDeploymentSuccessMetrics,
  formatMinutesAsDuration,
  generateBreadcrumb,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/helpers";
import { useGetBlueprintById } from "@amzn/innovation-sandbox-frontend/domains/blueprints/hooks";
import { getConcurrencyModeLabel } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

export const ViewBlueprint = () => {
  const { blueprintId } = useParams<{ blueprintId: string }>();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();
  const { isAdmin } = useUser();

  const query = useGetBlueprintById(blueprintId!);
  const { data, isLoading, isError, error, refetch } = query;

  useEffect(() => {
    const breadcrumbs = generateBreadcrumb(query);
    setBreadcrumb(breadcrumbs);
    setTools(<Markdown file="blueprint-details" />);
  }, [query, setBreadcrumb, setTools]);

  if (isLoading) {
    return (
      <ContentLayout>
        <Loader />
      </ContentLayout>
    );
  }

  if (isError) {
    return (
      <ContentLayout>
        <ErrorPanel
          retry={refetch}
          description="We couldn't load the blueprint details. Try refreshing the page."
          error={error as Error}
        />
      </ContentLayout>
    );
  }

  if (!data?.blueprint) {
    return (
      <ContentLayout>
        <ErrorPanel
          retry={refetch}
          description="We can't find this blueprint. It may have been unregistered."
          error={new Error("Blueprint not found")}
        />
      </ContentLayout>
    );
  }

  const { blueprint, stackSets, recentDeployments } = data;

  const basicDetailsItems: Array<{ label: string; value: string }> = [];

  basicDetailsItems.push({ label: "Name", value: blueprint.name });
  basicDetailsItems.push({
    label: "Blueprint ID",
    value: blueprint.blueprintId,
  });
  basicDetailsItems.push({ label: "Created by", value: blueprint.createdBy });
  basicDetailsItems.push({
    label: "Created",
    value: blueprint.meta.createdTime,
  });
  basicDetailsItems.push({
    label: "Last updated",
    value: blueprint.meta.lastEditTime,
  });

  const tagsTableItems =
    blueprint.tags && Object.keys(blueprint.tags).length > 0
      ? Object.entries(blueprint.tags).map(([key, value]) => ({
          key,
          value,
        }))
      : [];

  const healthMetricsItems = [
    {
      label: "Total deployments",
      value: blueprint.totalHealthMetrics.totalDeploymentCount.toString(),
    },
    {
      label: "Successful deployments",
      value: formatDeploymentSuccessMetrics(
        blueprint.totalHealthMetrics.totalSuccessfulCount,
        blueprint.totalHealthMetrics.totalDeploymentCount,
      ),
    },
    {
      label: "Last deployment",
      value: blueprint.totalHealthMetrics.lastDeploymentAt || "-",
    },
  ];

  // Build deployment config items imperatively (5 parameters)
  const deploymentConfigItems: Array<{ label: string; value: string }> = [];

  deploymentConfigItems.push({
    label: "Deployment timeout",
    value: formatMinutesAsDuration(blueprint.deploymentTimeoutMinutes),
  });

  deploymentConfigItems.push({
    label: "Region concurrency type",
    value:
      blueprint.regionConcurrencyType === RegionConcurrencyType.SEQUENTIAL
        ? "Sequential (one region at a time)"
        : "Parallel (all regions simultaneously)",
  });

  if (stackSets && stackSets.length > 0) {
    const stackSet = stackSets[0];

    deploymentConfigItems.push({
      label: "Concurrent deployments",
      value: `${stackSet.maxConcurrentPercentage}%`,
    });

    deploymentConfigItems.push({
      label: "Failure tolerance",
      value: `${stackSet.failureTolerancePercentage}%`,
    });

    deploymentConfigItems.push({
      label: "Concurrency mode",
      value: getConcurrencyModeLabel(stackSet.concurrencyMode),
    });
  }

  return (
    <ContentLayout header={<Header variant="h1">{blueprint.name}</Header>}>
      <SpaceBetween size="l">
        <Container
          header={
            <Header
              variant="h2"
              actions={
                isAdmin ? (
                  <Button
                    iconName="edit"
                    onClick={() =>
                      navigate(`/blueprints/${blueprintId}/edit/basic`)
                    }
                  >
                    Edit
                  </Button>
                ) : undefined
              }
            >
              Basic details
            </Header>
          }
        >
          <KeyValuePairs columns={2} items={basicDetailsItems} />
        </Container>

        {tagsTableItems.length > 0 && (
          <Container
            header={
              <Header
                variant="h2"
                actions={
                  isAdmin ? (
                    <Button
                      iconName="edit"
                      onClick={() =>
                        navigate(`/blueprints/${blueprintId}/edit/basic`)
                      }
                    >
                      Edit
                    </Button>
                  ) : undefined
                }
              >
                Tags
              </Header>
            }
          >
            <Table
              variant="embedded"
              columnDefinitions={[
                {
                  id: "key",
                  header: "Key",
                  cell: (item: { key: string; value: string }) => item.key,
                  sortingField: "key",
                },
                {
                  id: "value",
                  header: "Value",
                  cell: (item: { key: string; value: string }) => item.value,
                  sortingField: "value",
                },
              ]}
              items={tagsTableItems}
              sortingDisabled={false}
            />
          </Container>
        )}

        <Container
          header={
            <Header
              variant="h2"
              actions={
                isAdmin ? (
                  <Button
                    iconName="edit"
                    onClick={() =>
                      navigate(`/blueprints/${blueprintId}/edit/deployment`)
                    }
                  >
                    Edit
                  </Button>
                ) : undefined
              }
            >
              Deployment configuration
            </Header>
          }
        >
          <KeyValuePairs columns={2} items={deploymentConfigItems} />
        </Container>

        <Container header={<Header variant="h2">Health metrics</Header>}>
          <ColumnLayout columns={3} variant="text-grid">
            <KeyValuePairs columns={1} items={healthMetricsItems} />
          </ColumnLayout>
        </Container>

        {recentDeployments && recentDeployments.length > 0 && (
          <Container
            header={
              <Header
                variant="h2"
                actions={
                  <Button
                    iconName="refresh"
                    onClick={() => refetch()}
                    disabled={isLoading}
                  />
                }
              >
                Recent deployments
              </Header>
            }
          >
            <DeploymentHistoryTable deployments={recentDeployments} />
          </Container>
        )}

        {stackSets && stackSets.length > 0 && (
          <Container
            header={
              <Header
                variant="h2"
                description={
                  stackSets.length > 1
                    ? `${stackSets.length} StackSets configured`
                    : undefined
                }
              >
                StackSet details
              </Header>
            }
          >
            <SpaceBetween size="l">
              {stackSets.map((stackSet, index) => (
                <Container
                  key={stackSet.stackSetId}
                  header={
                    stackSets.length > 1 ? (
                      <Header variant="h3">
                        StackSet {index + 1} (Order: {stackSet.deploymentOrder})
                      </Header>
                    ) : undefined
                  }
                >
                  <KeyValuePairs
                    columns={2}
                    items={[
                      {
                        label: "StackSet name",
                        value: extractStackSetNameFromId(stackSet.stackSetId),
                      },
                      { label: "StackSet ID", value: stackSet.stackSetId },
                      {
                        label: "Administration role",
                        value: stackSet.administrationRoleArn,
                      },
                      {
                        label: "Execution role",
                        value: stackSet.executionRoleName,
                      },
                      {
                        label: "Regions",
                        value: stackSet.regions.join(", "),
                      },
                      {
                        label: "Deployment count",
                        value:
                          stackSet.healthMetrics.deploymentCount.toString(),
                      },
                      {
                        label: "Successful deployments",
                        value:
                          stackSet.healthMetrics.successfulDeploymentCount.toString(),
                      },
                      {
                        label: "Consecutive failures",
                        value:
                          stackSet.healthMetrics.consecutiveFailures.toString(),
                      },
                    ]}
                  />
                </Container>
              ))}
            </SpaceBetween>
          </Container>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
};
