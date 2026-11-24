// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert } from "@cloudscape-design/components";

import { CostReportingForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CostReportingForm";
import {
  costMonitoringFieldNames,
  LeasesForm,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/LeasesForm";
import { ConfigurationForm } from "@amzn/innovation-sandbox-frontend/domains/settings/useConfigurationForm";

import {
  configurationGroup,
  SettingsGroupController,
} from "./configurationGroup";

export function costSettingsGroup(
  leases: ConfigurationForm<"leases">,
  costReporting: ConfigurationForm<"costReporting">,
): SettingsGroupController {
  return {
    ...configurationGroup([
      {
        label: "Cost monitoring",
        form: leases,
        fields: costMonitoringFieldNames,
      },
      { label: "Cost report groups", form: costReporting },
    ]),
    getSaveWarning: () => {
      const groups: string[] =
        costReporting.methods.getValues("costReportGroups");
      const removed = costReporting.baseline.costReportGroups.filter(
        (name) => !groups.includes(name),
      );
      return removed.length ? (
        <Alert type="warning" header="Remove cost report groups?">
          Removing: {removed.join(", ")}. Existing templates and leases keep
          these groups; they cannot be selected for new templates.
        </Alert>
      ) : null;
    },
    render: (visible) =>
      visible && (
        <>
          <LeasesForm group="cost" />
          <CostReportingForm />
        </>
      ),
  };
}
