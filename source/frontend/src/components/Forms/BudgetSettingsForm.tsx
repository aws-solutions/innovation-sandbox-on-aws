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
import { useFieldArray, useFormContext } from "react-hook-form";

import { BudgetThreshold } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import SelectField from "@amzn/innovation-sandbox-frontend/components/FormFields/SelectField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { useEffect } from "react";

export const THRESHOLD_ACTION_OPTIONS: readonly SelectProps.Option[] = [
  { label: "Send Alert", value: "ALERT" },
  { label: "Freeze Lease", value: "FREEZE_ACCOUNT" },
] as const;

export interface BudgetSettingsFormValues {
  maxBudgetEnabled: boolean;
  maxSpend?: number;
  budgetThresholds?: BudgetThreshold[];
}

export interface BudgetSettingsFormProps {
  /** Global maximum budget limit (optional) */
  globalMaxBudget?: number;
  /** Whether maximum budget is required by organization policy */
  requireMaxBudget: boolean;
}

/**
 * Reusable form component for budget settings.
 * Uses FormContext from parent - no internal state management.
 * Can be used in both lease templates and lease management.
 */
export function BudgetSettingsForm({
  globalMaxBudget,
  requireMaxBudget,
}: BudgetSettingsFormProps) {
  // Get control and trigger from form context
  const { control, trigger, watch, resetField } =
    useFormContext<BudgetSettingsFormValues>();

  // Watch form values for dynamic UI and cross-field validation
  const { maxBudgetEnabled, maxSpend } = watch();

  // Handle dynamic threshold array with useFieldArray
  const { fields, append, remove } = useFieldArray({
    control,
    name: "budgetThresholds",
  });

  useEffect(() => {
    if (!maxBudgetEnabled) {
      resetField("maxSpend");
    }
  }, [maxBudgetEnabled, resetField]);

  return (
    <SpaceBetween size="l">
      <ToggleField
        controllerProps={{ control, name: "maxBudgetEnabled" }}
        formFieldProps={{
          label: "Enable Maximum Budget",
          description: requireMaxBudget
            ? "Maximum budget is required by your organization"
            : "When enabled, leases using this template will have a spending limit",
        }}
        toggleProps={{
          children: `Budget limit ${maxBudgetEnabled || requireMaxBudget ? "enabled" : "disabled"}`,
          disabled: requireMaxBudget,
        }}
      />

      {!maxBudgetEnabled && !requireMaxBudget && (
        <Alert type="warning">
          Without a maximum budget, accounts may incur unexpected costs.
          Consider enabling a budget limit.
        </Alert>
      )}

      {(maxBudgetEnabled || requireMaxBudget) && (
        <ColumnLayout columns={3} variant="default">
          <InputField
            controllerProps={{ control, name: "maxSpend" }}
            formFieldProps={{
              label: "Maximum Spend (USD)",
              description: globalMaxBudget
                ? `Maximum allowed budget per lease. Global limit: $${globalMaxBudget}`
                : "Maximum allowed budget per lease",
            }}
            inputProps={{
              type: "number",
              placeholder: "e.g., 50",
              inputMode: "decimal",
              onChange: () => trigger(),
            }}
          />
        </ColumnLayout>
      )}

      <FormField
        label={
          <>
            Budget Thresholds - <i>Optional</i>
          </>
        }
        description="Trigger alerts or freeze accounts when spending reaches specific amounts. Only one 'Freeze Lease' threshold is allowed."
        stretch
      >
        {(fields.length > 0 || (!!maxSpend && maxSpend > 0)) && (
          <ColumnLayout columns={3} variant="default">
            <Box variant="awsui-key-label" color="text-body-secondary">
              Amount (USD)
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
                  name: `budgetThresholds.${index}.dollarsSpent` as const,
                }}
                formFieldProps={{}}
                inputProps={{
                  type: "number",
                  placeholder: "e.g., 25",
                  inputMode: "decimal",
                }}
              />

              <SelectField
                controllerProps={{
                  control,
                  name: `budgetThresholds.${index}.action` as const,
                }}
                selectProps={{
                  placeholder: "Choose an action",
                  options: THRESHOLD_ACTION_OPTIONS,
                  valueToOption: (value) =>
                    THRESHOLD_ACTION_OPTIONS.find(
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

          {/* Visual indicator: Max budget breach terminates lease */}
          {!!maxSpend && maxSpend > 0 && (
            <ColumnLayout columns={3} variant="default">
              <FormField>
                <Input
                  type="number"
                  value={String(maxSpend)}
                  disabled
                  readOnly
                />
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
                dollarsSpent: 0,
                action: "ALERT",
              });
            }}
          >
            Add Threshold
          </Button>
        </SpaceBetween>
      </FormField>
    </SpaceBetween>
  );
}
