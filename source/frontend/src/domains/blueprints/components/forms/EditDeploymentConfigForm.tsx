// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SpaceBetween } from "@cloudscape-design/components";

import { DeploymentStrategyForm } from "./DeploymentStrategyForm";
import { DeploymentTimeoutForm } from "./DeploymentTimeoutForm";

export function EditDeploymentConfigForm() {
  return (
    <SpaceBetween size="l">
      <DeploymentStrategyForm />
      <DeploymentTimeoutForm />
    </SpaceBetween>
  );
}
