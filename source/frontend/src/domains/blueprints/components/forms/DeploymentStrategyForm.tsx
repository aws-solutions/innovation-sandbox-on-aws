// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  ColumnLayout,
  Container,
  FormField,
  Header,
  RadioGroup,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useCallback } from "react";
import { Controller, useFormContext } from "react-hook-form";

import RadioGroupField from "@amzn/innovation-sandbox-frontend/components/FormFields/RadioGroupField";
import SliderField from "@amzn/innovation-sandbox-frontend/components/FormFields/SliderField";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { getDeploymentConfig } from "@amzn/innovation-sandbox-frontend/domains/blueprints/helpers";
import {
  CONCURRENCY_MODE_OPTIONS,
  ConcurrencyMode,
  DEPLOYMENT_STRATEGY_CONFIGS,
  DeploymentStrategy,
  REGION_CONCURRENCY_OPTIONS,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import {
  CONCURRENT_PERCENTAGE_CONSTRAINTS,
  FAILURE_TOLERANCE_CONSTRAINTS,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";

interface DeploymentStrategyFormValues {
  deploymentStrategy: DeploymentStrategy;
  regionConcurrencyType: {
    value: string;
    label: string;
    description?: string;
  };
  maxConcurrentPercentage: number;
  failureTolerancePercentage: number;
  concurrencyMode: ConcurrencyMode;
}

export function DeploymentStrategyForm() {
  const { control, watch, setValue } =
    useFormContext<DeploymentStrategyFormValues>();

  const deploymentStrategy = watch("deploymentStrategy");

  const handleStrategyChange = useCallback(
    (newStrategy: DeploymentStrategy) => {
      setValue("deploymentStrategy", newStrategy, {
        shouldValidate: true,
        shouldDirty: true,
      });

      if (newStrategy !== "Custom") {
        const config = getDeploymentConfig(newStrategy);
        const concurrencyOption =
          config.regionConcurrencyType === "Sequential"
            ? REGION_CONCURRENCY_OPTIONS.SEQUENTIAL
            : REGION_CONCURRENCY_OPTIONS.PARALLEL;
        setValue("regionConcurrencyType", concurrencyOption, {
          shouldValidate: true,
          shouldDirty: true,
        });
        setValue("maxConcurrentPercentage", config.maxConcurrentPercentage, {
          shouldValidate: true,
          shouldDirty: true,
        });
        setValue(
          "failureTolerancePercentage",
          config.failureTolerancePercentage,
          {
            shouldValidate: true,
            shouldDirty: true,
          },
        );
        setValue("concurrencyMode", config.concurrencyMode, {
          shouldValidate: true,
          shouldDirty: true,
        });
      }
    },
    [setValue],
  );

  return (
    <Container
      header={
        <Header
          variant="h2"
          info={<InfoLink markdown="deployment-configuration" />}
        >
          Deployment strategy
        </Header>
      }
    >
      <ColumnLayout columns={2} variant="text-grid">
        <FormField description="Choose how to deploy across regions">
          <RadioGroup
            value={deploymentStrategy}
            onChange={({ detail }) =>
              handleStrategyChange(detail.value as DeploymentStrategy)
            }
            items={Object.entries(DEPLOYMENT_STRATEGY_CONFIGS).map(
              ([value, config]) => ({
                value,
                label: config.label,
                description: config.description,
              }),
            )}
          />
        </FormField>

        {deploymentStrategy !== "Custom" ? (
          <Box variant="p" color="text-body-secondary">
            Deploys to one region at a time. If any region fails, the deployment
            stops immediately. This is the safest approach for new blueprints.
            For multiple regions, consider increasing the timeout below. Choose
            Custom to configure deployment parameters manually.
          </Box>
        ) : (
          <SpaceBetween size="l">
            <SliderField<
              DeploymentStrategyFormValues,
              "maxConcurrentPercentage"
            >
              controllerProps={{ control, name: "maxConcurrentPercentage" }}
              formFieldProps={{
                label: `Concurrent deployments: ${watch("maxConcurrentPercentage")}%`,
                description:
                  "Choose how many regions to deploy to at the same time",
              }}
              sliderProps={{
                min: CONCURRENT_PERCENTAGE_CONSTRAINTS.MIN,
                max: CONCURRENT_PERCENTAGE_CONSTRAINTS.MAX,
                step: CONCURRENT_PERCENTAGE_CONSTRAINTS.STEP,
                valueFormatter: (value) => `${value}%`,
                referenceValues:
                  CONCURRENT_PERCENTAGE_CONSTRAINTS.REFERENCE_VALUES,
              }}
            />

            <SliderField<
              DeploymentStrategyFormValues,
              "failureTolerancePercentage"
            >
              controllerProps={{ control, name: "failureTolerancePercentage" }}
              formFieldProps={{
                label: `Failure tolerance: ${watch("failureTolerancePercentage")}%`,
                description:
                  "Stop deployment if this percentage of regions fail",
              }}
              sliderProps={{
                min: FAILURE_TOLERANCE_CONSTRAINTS.MIN,
                max: FAILURE_TOLERANCE_CONSTRAINTS.MAX,
                step: FAILURE_TOLERANCE_CONSTRAINTS.STEP,
                valueFormatter: (value) => `${value}%`,
                referenceValues: FAILURE_TOLERANCE_CONSTRAINTS.REFERENCE_VALUES,
              }}
            />

            <Controller
              control={control}
              name="regionConcurrencyType"
              render={({ field }) => (
                <FormField
                  label="Concurrency"
                  description="Specifies whether to deploy to regions sequentially or in parallel"
                >
                  <RadioGroup
                    value={field.value.value}
                    onChange={({ detail }) =>
                      field.onChange(
                        detail.value ===
                          REGION_CONCURRENCY_OPTIONS.SEQUENTIAL.value
                          ? REGION_CONCURRENCY_OPTIONS.SEQUENTIAL
                          : REGION_CONCURRENCY_OPTIONS.PARALLEL,
                      )
                    }
                    items={Object.values(REGION_CONCURRENCY_OPTIONS)}
                  />
                </FormField>
              )}
            />

            <RadioGroupField<DeploymentStrategyFormValues, "concurrencyMode">
              controllerProps={{ control, name: "concurrencyMode" }}
              formFieldProps={{
                label: "Concurrency mode",
                description:
                  "Specifies how the concurrency level behaves when failures occur",
              }}
              radioGroupProps={{
                items: Object.values(CONCURRENCY_MODE_OPTIONS),
              }}
            />
          </SpaceBetween>
        )}
      </ColumnLayout>
    </Container>
  );
}
