// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Container, Header } from "@cloudscape-design/components";
import { useFormContext } from "react-hook-form";

import SliderField from "@amzn/innovation-sandbox-frontend/components/FormFields/SliderField";
import {
  formatMinutesAsCompactDuration,
  formatMinutesAsDuration,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/helpers";
import { BLUEPRINT_DEPLOYMENT_TIMEOUT } from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";

interface DeploymentTimeoutFormValues {
  deploymentTimeout: number;
  regionConcurrencyType: {
    value: string;
    label: string;
    description?: string;
  };
}

export function DeploymentTimeoutForm() {
  const { control, watch } = useFormContext<DeploymentTimeoutFormValues>();

  const { deploymentTimeout, regionConcurrencyType } = watch();

  return (
    <Container header={<Header variant="h2">Timeout</Header>}>
      <SliderField<DeploymentTimeoutFormValues, "deploymentTimeout">
        controllerProps={{ control, name: "deploymentTimeout" }}
        formFieldProps={{
          label: `Timeout: ${formatMinutesAsDuration(
            deploymentTimeout ?? BLUEPRINT_DEPLOYMENT_TIMEOUT.DEFAULT,
          )}`,
          description: `Maximum time to wait for deployment to complete. ${
            regionConcurrencyType.value === "Sequential"
              ? "Tip: Sequential deployments across multiple regions may need longer timeouts."
              : "Tip: Parallel deployments typically complete faster."
          }`,
        }}
        sliderProps={{
          min: BLUEPRINT_DEPLOYMENT_TIMEOUT.MIN,
          max: BLUEPRINT_DEPLOYMENT_TIMEOUT.MAX,
          step: BLUEPRINT_DEPLOYMENT_TIMEOUT.STEP,
          valueFormatter: formatMinutesAsCompactDuration,
          referenceValues: BLUEPRINT_DEPLOYMENT_TIMEOUT.REFERENCE_VALUES,
        }}
      />
    </Container>
  );
}
