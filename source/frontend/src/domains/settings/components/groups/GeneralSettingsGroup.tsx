// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert } from "@cloudscape-design/components";

import { DeploymentSettings } from "@amzn/innovation-sandbox-frontend/domains/settings/components/DeploymentSettings";
import { MaintenanceForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/MaintenanceForm";
import { TermsOfServiceForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/TermsOfServiceForm";
import { AdminConfigurationView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { ConfigurationForm } from "@amzn/innovation-sandbox-frontend/domains/settings/useConfigurationForm";

import {
  configurationGroup,
  SettingsGroupController,
} from "./configurationGroup";

export function generalSettingsGroup(
  maintenance: ConfigurationForm<"maintenance">,
  termsOfService: ConfigurationForm<"termsOfService">,
  config: AdminConfigurationView,
): SettingsGroupController {
  return {
    ...configurationGroup([
      { label: "Maintenance mode", form: maintenance },
      { label: "Terms of service", form: termsOfService },
    ]),
    getSaveWarning: () =>
      maintenance.methods.getValues("enabled") &&
      !maintenance.baseline.enabled ? (
        <Alert type="warning" header="Turn on maintenance mode?">
          Turning this on locks managers and users out of Innovation Sandbox.
          Admins keep full access, and existing sandbox accounts keep running.
        </Alert>
      ) : null,
    render: (visible) =>
      visible && (
        <>
          <MaintenanceForm />
          <TermsOfServiceForm />
          <DeploymentSettings config={config} />
        </>
      ),
  };
}
