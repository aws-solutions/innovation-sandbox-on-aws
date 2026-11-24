// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  ColumnLayout,
  FormField,
  Input,
  Select,
  SelectProps,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import SelectField from "@amzn/innovation-sandbox-frontend/components/FormFields/SelectField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { PredictiveDurationWarning } from "@amzn/innovation-sandbox-frontend/components/Forms/PredictiveDurationWarning";
import { DurationThreshold } from "@amzn/innovation-sandbox-shared/types/lease-template";

export const DURATION_ACTION_OPTIONS: readonly SelectProps.Option[] = [
  { label: "Send Alert", value: "ALERT" },
  { label: "Freeze Lease", value: "FREEZE_ACCOUNT" },
] as const;

export interface DurationSettingsFormValues {
  maxDurationEnabled: boolean;
  leaseDurationInHours?: number;
  durationThresholds?: DurationThreshold[];
}

export interface DurationSettingsFormProps {
  /** Global maximum duration limit in hours (optional) */
  globalMaxDurationHours?: number;
  /** Whether maximum duration is required by organization policy */
  requireMaxDuration: boolean;
  /**
   * Whether predictive budget controls apply to leases with this duration,
   * for the short-lease warning. Live form value on the wizard, the persisted
   * template value on the edit page.
   */
  predictiveBudgetEnabled?: boolean;
}

/**
 * Form component for lease template duration settings.
 * Uses FormContext from parent - no internal state management.
 * Used for lease templates with hours-based duration.
 */
export function DurationSettingsForm({
  globalMaxDurationHours,
  requireMaxDuration,
  predictiveBudgetEnabled,
}: Readonly<DurationSettingsFormProps>) {
  // Get control and trigger from form context
  const { control, trigger, resetField } =
    useFormContext<DurationSettingsFormValues>();

  // Watch form values for dynamic UI and cross-field validation
  const maxDurationEnabled = useWatch({ control, name: "maxDurationEnabled" });
  const leaseDurationInHours = useWatch({
    control,
    name: "leaseDurationInHours",
  });

  // Handle dynamic threshold array with useFieldArray
  const { fields, append, remove } = useFieldArray({
    control,
    name: "durationThresholds",
  });

  return (
    <SpaceBetween size="l">
      <ToggleField
        controllerProps={{ control, name: "maxDurationEnabled" }}
        valueToChecked={(value) => value || requireMaxDuration}
        formFieldProps={{
          label: "Enable Maximum Duration",
          description: requireMaxDuration
            ? "Maximum duration is required by your organization"
            : "When enabled, leases using this template will have a time limit",
        }}
        toggleProps={{
          children: `Duration limit ${maxDurationEnabled || requireMaxDuration ? "enabled" : "disabled"}`,
          disabled: requireMaxDuration,
          // The duration and its thresholds are hidden while the toggle is off,
          // so put back their starting values rather than leave an invalid
          // value nobody can see or fix. That also clears the threshold
          // errors, so check the thresholds again when it comes back on.
          onChange: (event) => {
            if (event.detail.checked) {
              trigger("durationThresholds");
            } else {
              resetField("leaseDurationInHours");
              resetField("durationThresholds");
            }
          },
        }}
      />

      {!maxDurationEnabled && !requireMaxDuration && (
        <Alert type="warning">
          Without a maximum duration, leases may remain active indefinitely.
          Consider enabling a time limit.
        </Alert>
      )}

      <PredictiveDurationWarning
        predictiveBudgetEnabled={predictiveBudgetEnabled}
        durationHours={
          maxDurationEnabled || requireMaxDuration
            ? leaseDurationInHours
            : undefined
        }
        variant="template"
      />

      {(maxDurationEnabled || requireMaxDuration) && (
        <ColumnLayout columns={3} variant="default">
          <InputField
            controllerProps={{ control, name: "leaseDurationInHours" }}
            min={0}
            max={globalMaxDurationHours}
            formFieldProps={{
              label: "Maximum Duration (Hours)",
              description: globalMaxDurationHours
                ? `Maximum allowed duration per lease. Global limit: ${globalMaxDurationHours} hours`
                : "Maximum allowed duration per lease",
            }}
            inputProps={{
              type: "number",
              step: "any",
              placeholder: "e.g., 168 (1 week)",
              inputMode: "decimal",
              onChange: () => trigger(),
            }}
          />
        </ColumnLayout>
      )}

      {(maxDurationEnabled || requireMaxDuration) && (
        <FormField
          label={
            <>
              Duration Thresholds - <i>Optional</i>
            </>
          }
          description="Trigger alerts or freeze accounts when time remaining reaches specific thresholds. Only one 'Freeze Lease' threshold is allowed."
        >
          {(fields.length > 0 ||
            (!!leaseDurationInHours && leaseDurationInHours > 0)) && (
            <ColumnLayout columns={3} variant="default">
              <Box variant="awsui-key-label" color="text-body-secondary">
                Hours Remaining
              </Box>
              <Box variant="awsui-key-label" color="text-body-secondary">
                Action
              </Box>
            </ColumnLayout>
          )}
          <SpaceBetween size="l">
            {fields.map((field, index) => (
              <ColumnLayout key={field.id} columns={3} variant="default">
                <InputField
                  controllerProps={{
                    control,
                    name: `durationThresholds.${index}.hoursRemaining` as const,
                  }}
                  min={0}
                  inputProps={{
                    type: "number",
                    step: "any",
                    placeholder: "e.g., 24",
                    inputMode: "decimal",
                  }}
                />

                <SelectField
                  controllerProps={{
                    control,
                    name: `durationThresholds.${index}.action` as const,
                  }}
                  selectProps={{
                    options: DURATION_ACTION_OPTIONS,
                    valueToOption: (value) =>
                      DURATION_ACTION_OPTIONS.find(
                        (opt) => opt.value === value,
                      ) || null,
                    optionToValue: (option) =>
                      option?.value as "ALERT" | "FREEZE_ACCOUNT" | undefined,
                    onChange: () => trigger(),
                  }}
                />

                <Button
                  variant="normal"
                  formAction="none"
                  onClick={() => remove(index)}
                  ariaLabel={`Remove threshold ${index + 1}`}
                >
                  Remove
                </Button>
              </ColumnLayout>
            ))}

            {/* Visual indicator: Max duration expiration terminates lease */}
            {!!leaseDurationInHours && leaseDurationInHours > 0 && (
              <ColumnLayout columns={3} variant="default">
                <FormField>
                  <Input type="number" value="0" disabled readOnly />
                </FormField>
                <FormField>
                  <Select
                    selectedOption={{
                      label: "Terminate Lease",
                      value: "TERMINATE",
                    }}
                    disabled
                  />
                </FormField>
              </ColumnLayout>
            )}

            <Button
              iconName="add-plus"
              formAction="none"
              onClick={() => {
                append({
                  hoursRemaining: 0,
                  action: "ALERT",
                });
              }}
            >
              Add Threshold
            </Button>
          </SpaceBetween>
        </FormField>
      )}
    </SpaceBetween>
  );
}
