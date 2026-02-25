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

import { DurationThreshold } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import DateTimeField from "@amzn/innovation-sandbox-frontend/components/FormFields/DateTimeField";
import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import SelectField from "@amzn/innovation-sandbox-frontend/components/FormFields/SelectField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";

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
}

/**
 * Form component for lease expiration settings.
 * Uses FormContext from parent - no internal state management.
 * Used for lease management with date/time picker.
 */
export function ExpirationSettingsForm({
  requireMaxDuration,
}: ExpirationSettingsFormProps) {
  // Get control and trigger from form context
  const { control, trigger } = useFormContext<ExpirationSettingsFormValues>();

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
    action: string,
  ): SelectProps.Option | null => {
    return (
      EXPIRATION_ACTION_OPTIONS.find((opt) => opt.value === action) || null
    );
  };

  const getExpirationActionValue = (
    option: SelectProps.Option | null,
  ): string => {
    return (option?.value as string) || "ALERT";
  };

  return (
    <SpaceBetween size="l">
      <ToggleField
        controllerProps={{ control, name: "maxDurationEnabled" }}
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
        }}
      />

      {!maxDurationEnabled && !requireMaxDuration && (
        <Alert type="warning">
          Without an expiration date, this lease will remain active
          indefinitely. Consider setting an expiration date.
        </Alert>
      )}

      {(maxDurationEnabled || requireMaxDuration) && (
        <DateTimeField
          controllerProps={{ control, name: "expirationDate" }}
          formFieldProps={{
            label: "Expiration Date",
            description: "Select when this lease should expire",
          }}
        />
      )}

      {maxDurationEnabled && (
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
                  inputProps={{
                    type: "number",
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
                } as DurationThreshold);
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
