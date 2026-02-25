// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SpaceBetween } from "@cloudscape-design/components";

import { DeploymentStrategyForm } from "./DeploymentStrategyForm";
import { DeploymentTimeoutForm } from "./DeploymentTimeoutForm";
import { RegionSelectionForm } from "./RegionSelectionForm";

export function DeploymentConfigurationForm() {
  return (
    <SpaceBetween size="l">
      <RegionSelectionForm />
      <DeploymentStrategyForm />
      <DeploymentTimeoutForm />
    </SpaceBetween>
  );
}
