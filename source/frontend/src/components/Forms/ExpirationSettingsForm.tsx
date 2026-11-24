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

import DateTimeField from "@amzn/innovation-sandbox-frontend/components/FormFields/DateTimeField";
import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import SelectField from "@amzn/innovation-sandbox-frontend/components/FormFields/SelectField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import {
  hoursBetween,
  PredictiveDurationWarning,
} from "@amzn/innovation-sandbox-frontend/components/Forms/PredictiveDurationWarning";
import { DurationThreshold } from "@amzn/innovation-sandbox-shared/types/lease-template";

export const EXPIRATION_ACTION_OPTIONS: readonly SelectProps.Option[] = [
  { label: "Send Alert", value: "ALERT" },
  { label: "Freeze Lease", value: "FREEZE_ACCOUNT" },
] as const;

export interface ExpirationSettingsFormValues {
  maxDurationEnabled: boolean;
  expirationDate?: string; // ISO 8601 datetime string
  durationThresholds?: DurationThreshold[];
}

export interface ExpirationSettingsFormProps {
  /** Whether expiration date is required by organization policy */
  requireMaxDuration: boolean;
  /** The lease's opt-in, for the short-lease warning */
  predictiveBudgetEnabled?: boolean;
  /**
   * The lease's start date. The warning measures the lease's total hours from
   * here to the chosen expiry — a young lease whose expiry is brought inside
   * 48 hours of its start can end before a spending rate ever exists.
   */
  leaseStartDate?: string;
}

/**
 * Form component for lease expiration settings.
 * Uses FormContext from parent - no internal state management.
 * Used for lease management with date/time picker.
 */
export function ExpirationSettingsForm({
  requireMaxDuration,
  predictiveBudgetEnabled,
  leaseStartDate,
}: Readonly<ExpirationSettingsFormProps>) {
  // Get control and trigger from form context
  const { control, trigger, resetField } =
    useFormContext<ExpirationSettingsFormValues>();

  // Watch form values for dynamic UI
  const maxDurationEnabled = useWatch({ control, name: "maxDurationEnabled" });
  const expirationDate = useWatch({ control, name: "expirationDate" });

  // Handle dynamic threshold array with useFieldArray
  const { fields, append, remove } = useFieldArray({
    control,
    name: "durationThresholds",
  });

  // Helper functions for SelectField value transformation
  const getExpirationActionOption = (
    action: DurationThreshold["action"] | undefined,
  ): SelectProps.Option | null => {
    return (
      EXPIRATION_ACTION_OPTIONS.find((opt) => opt.value === action) || null
    );
  };

  const getExpirationActionValue = (
    option: SelectProps.Option | null,
  ): DurationThreshold["action"] =>
    (option?.value as DurationThreshold["action"] | undefined) ?? "ALERT";

  return (
    <SpaceBetween size="l">
      <ToggleField
        controllerProps={{ control, name: "maxDurationEnabled" }}
        valueToChecked={(value) => value || requireMaxDuration}
        formFieldProps={{
          label: "Enable Expiration Date",
          description: requireMaxDuration
            ? "Expiration date is required by your organization"
            : "When enabled, the lease will automatically expire at the specified date and time",
        }}
        toggleProps={{
          children:
            maxDurationEnabled || requireMaxDuration ? "Enabled" : "Disabled",
          disabled: requireMaxDuration,
          // The date and thresholds are hidden while the toggle is off, so put
          // back their starting values rather than leave an invalid value
          // nobody can see or fix. That also clears the threshold errors, so
          // check the thresholds again when the toggle comes back on.
          onChange: (event) => {
            if (event.detail.checked) {
              trigger("durationThresholds");
            } else {
              resetField("expirationDate");
              resetField("durationThresholds");
            }
          },
        }}
      />

      {!maxDurationEnabled && !requireMaxDuration && (
        <Alert type="warning">
          Without an expiration date, this lease will remain active
          indefinitely. Consider setting an expiration date.
        </Alert>
      )}

      <PredictiveDurationWarning
        predictiveBudgetEnabled={predictiveBudgetEnabled}
        durationHours={
          maxDurationEnabled || requireMaxDuration
            ? hoursBetween(leaseStartDate, expirationDate)
            : undefined
        }
        variant="lease"
      />

      {(maxDurationEnabled || requireMaxDuration) && (
        <DateTimeField
          controllerProps={{ control, name: "expirationDate" }}
          formFieldProps={{
            label: "Expiration Date",
            description: "Select when this lease should expire",
          }}
        />
      )}

      {(maxDurationEnabled || requireMaxDuration) && (
        <FormField
          label={
            <>
              Duration Thresholds - <i>Optional</i>
            </>
          }
          description="Set actions to trigger when specific hours remain until expiration"
        >
          {(fields.length > 0 || !!expirationDate) && (
            <ColumnLayout columns={3} variant="default">
              <Box variant="awsui-key-label" color="text-body-secondary">
                Hours Remaining
              </Box>
              <Box variant="awsui-key-label" color="text-body-secondary">
                Action
              </Box>
            </ColumnLayout>
          )}
          <SpaceBetween size="s">
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
                    placeholder: "Enter hours",
                    inputMode: "numeric",
                  }}
                />

                <SelectField
                  controllerProps={{
                    control,
                    name: `durationThresholds.${index}.action` as const,
                  }}
                  selectProps={{
                    options: EXPIRATION_ACTION_OPTIONS,
                    placeholder: "Select an action",
                    valueToOption: getExpirationActionOption,
                    optionToValue: getExpirationActionValue,
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
            {!!expirationDate && (
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
              Add threshold
            </Button>
          </SpaceBetween>
        </FormField>
      )}
    </SpaceBetween>
  );
}
