// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert, SpaceBetween } from "@cloudscape-design/components";
import type { SelectProps } from "@cloudscape-design/components/select";
import { useFormContext, useWatch } from "react-hook-form";

import SelectField from "@amzn/innovation-sandbox-frontend/components/FormFields/SelectField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";

export interface CostReportSettingsFormValues {
  costReportGroupEnabled: boolean;
  selectedCostReportGroup?: string;
}

export interface CostReportSettingsFormProps {
  /** Available cost report groups */
  costReportGroups?: string[];
  /** Whether cost report group is required by organization policy */
  requireCostReportGroup: boolean;
}

function getCostReportGroupOption(
  value: string | undefined,
  options: readonly SelectProps.Option[],
): SelectProps.Option | null {
  if (!value) return null;
  return options.find((opt) => opt.value === value) || null;
}

function getCostReportGroupValue(
  option: SelectProps.Option | null,
): string | undefined {
  return option?.value;
}

/**
 * Reusable form component for cost report settings.
 * Uses FormContext from parent - no internal state management.
 * Can be used in both lease templates and lease management.
 */
export function CostReportSettingsForm({
  costReportGroups,
  requireCostReportGroup = false,
}: CostReportSettingsFormProps) {
  // Get control from form context
  const { control } = useFormContext<CostReportSettingsFormValues>();

  // Watch form values for dynamic UI
  const costReportGroupEnabled = useWatch({
    control,
    name: "costReportGroupEnabled",
  });

  const costReportGroupOptions: readonly SelectProps.Option[] = costReportGroups
    ? costReportGroups.map((group: string) => ({
        label: group,
        value: group,
      }))
    : [];

  return (
    <SpaceBetween size="l">
      <ToggleField
        controllerProps={{ control, name: "costReportGroupEnabled" }}
        formFieldProps={{
          label: "Enable Cost Report Group",
          description: requireCostReportGroup
            ? "Cost report group is required by your organization"
            : "When enabled, leases using this template will be assigned to a cost report group for billing and reporting purposes",
        }}
        toggleProps={{
          children: `Cost reporting group ${costReportGroupEnabled || requireCostReportGroup ? "enabled" : "disabled"}`,
          disabled: requireCostReportGroup,
        }}
      />

      {!costReportGroupEnabled && !requireCostReportGroup && (
        <Alert type="warning">
          Without a cost report group, expenses cannot be allocated to specific
          teams or projects. Consider enabling cost reporting.
        </Alert>
      )}

      {(costReportGroupEnabled || requireCostReportGroup) && (
        <SelectField
          controllerProps={{ control, name: "selectedCostReportGroup" }}
          formFieldProps={{
            label: requireCostReportGroup ? (
              "Cost Report Group"
            ) : (
              <>
                Cost Report Group - <i>Optional</i>
              </>
            ),
            description:
              "Select the cost report group for billing allocation and expense tracking",
          }}
          selectProps={{
            options: costReportGroupOptions,
            placeholder: "Select a cost report group",
            valueToOption: (value) =>
              getCostReportGroupOption(value, costReportGroupOptions),
            optionToValue: getCostReportGroupValue,
          }}
        />
      )}
    </SpaceBetween>
  );
}
