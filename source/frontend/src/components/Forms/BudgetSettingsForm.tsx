// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  ColumnLayout,
  Container,
  FormField,
  Header,
  Link,
  Select,
  SelectProps,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useFieldArray, useFormContext } from "react-hook-form";

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import SelectField from "@amzn/innovation-sandbox-frontend/components/FormFields/SelectField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { globalGateIcon } from "@amzn/innovation-sandbox-frontend/components/Forms/GlobalGateIcon";
import { PredictiveDurationWarning } from "@amzn/innovation-sandbox-frontend/components/Forms/PredictiveDurationWarning";
import type { SettingsFormVariant } from "@amzn/innovation-sandbox-frontend/components/Forms/types";
import { RATE_LIMIT_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import {
  BudgetThreshold,
  RateLimitEntry,
  RateLimitsSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template";

export const THRESHOLD_ACTION_OPTIONS: readonly SelectProps.Option[] = [
  { label: "Send alert", value: "ALERT" },
  { label: "Freeze lease", value: "FREEZE_ACCOUNT" },
] as const;

export const TRIGGER_ON_OPTIONS: readonly SelectProps.Option[] = [
  { label: "Reported cost", value: "REPORTED" },
  { label: "Estimated cost", value: "PREDICTED" },
] as const;

export const RATE_PERIOD_OPTIONS: readonly SelectProps.Option[] = [
  { label: "Per hour", value: "HOURLY" },
  { label: "Per day", value: "DAILY" },
] as const;

export interface BudgetSettingsFormValues {
  maxBudgetEnabled: boolean;
  maxSpend?: number;
  budgetThresholds?: BudgetThreshold[];
  predictiveBudgetEnabled?: boolean;
  bedrockTokenMonitoringEnabled?: boolean;
  rateLimits?: RateLimitFormRow[];
}

/**
 * A spend-rate limit row as React Hook Form holds it. A number input reports
 * "" while blank, so a newly added row starts with no rate and stays invalid
 * until one is entered.
 */
export type RateLimitFormRow = Omit<RateLimitEntry, "rate"> & {
  rate: number | "";
};

/**
 * Undefined when there are no rows. Parsed against the persisted schema, so a
 * row the form validation should have stopped (such as a blank rate) throws
 * rather than being saved or dropped.
 */
export function parseRateLimitFormRows(
  rateLimits?: RateLimitFormRow[],
): RateLimitEntry[] | undefined {
  if (rateLimits === undefined || rateLimits.length === 0) {
    return undefined;
  }
  return RateLimitsSchema.parse(projectRateLimitRows(rateLimits));
}

/**
 * Undefined while any row is incomplete. Never throws, unlike
 * `parseRateLimitFormRows`, since it runs during render.
 */
export function tryParseRateLimitFormRows(
  rateLimits?: RateLimitFormRow[],
): RateLimitEntry[] | undefined {
  if (rateLimits === undefined) {
    return undefined;
  }
  return RateLimitsSchema.safeParse(projectRateLimitRows(rateLimits)).data;
}

function projectRateLimitRows(rateLimits: RateLimitFormRow[]) {
  return rateLimits.map(({ basis, rate, action }) => ({ basis, rate, action }));
}

/**
 * Removes triggerOn from every threshold. Used when saving with predictive
 * controls off, so a selector value chosen while they were on doesn't persist
 * as a threshold that could never fire.
 */
export function stripTriggerOn(
  thresholds?: BudgetThreshold[],
): BudgetThreshold[] | undefined {
  return thresholds?.map((threshold) => {
    const { triggerOn, ...rest } = threshold;
    return rest;
  });
}

/**
 * The template fields a saved budget form produces. With predictive controls
 * off, triggerOn selections and rate limits are dropped rather than saved as
 * configuration that could never fire. With predictive controls on, the
 * rate-limit list is sent even when empty: the template PUT keeps stored limits when the key is omitted, so
 * only an explicit `[]` clears removed rows. Bedrock token monitoring is a
 * separate opt-in and is saved as toggled.
 */
export function toTemplateBudgetFields(values: BudgetSettingsFormValues) {
  const predictiveBudgetEnabled = values.predictiveBudgetEnabled ?? false;
  return {
    budgetThresholds: predictiveBudgetEnabled
      ? values.budgetThresholds
      : stripTriggerOn(values.budgetThresholds),
    predictiveBudgetEnabled,
    bedrockTokenMonitoringEnabled:
      values.bedrockTokenMonitoringEnabled ?? false,
    rateLimits: predictiveBudgetEnabled
      ? (parseRateLimitFormRows(values.rateLimits) ?? [])
      : undefined,
  };
}

const COST_DETAILS_URL =
  "https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/cost.html";
const COST_TRACKING_DESCRIPTION =
  "Enhanced cost tracking that measures each lease's spend between billing reports. Each feature slightly increases the solution's operating cost, depending on how many leases use it.";
const ESTIMATED_COST_TRACKING_DESCRIPTION =
  "Estimates each lease's current cost from the trend in its reported spend. Lets budget thresholds use estimated cost, and enables spend rate thresholds.";
const BEDROCK_TOKEN_MONITORING_DESCRIPTION =
  "Monitors and attributes Amazon Bedrock token usage to the lease budget between Cost Explorer reports.";
const BUDGET_THRESHOLDS_DESCRIPTION =
  "Send an alert, freeze the lease, or terminate it when spend reaches an amount. Alerts and freezes can act on reported or estimated cost. The terminate threshold is the maximum budget. You can add one freeze threshold.";
const MAXIMUM_BUDGET_DESCRIPTION =
  "When current cost reaches the maximum budget, the lease is terminated and all of its resources are cleaned up. Current cost is the higher of reported cost and, when Amazon Bedrock token monitoring is on, reported cost with billed Amazon Bedrock charges replaced by the monitored token cost. This can't be undone, so don't use a maximum budget for accounts whose contents users can't afford to lose. Set the amount in the terminate threshold.";
const SPEND_RATE_THRESHOLDS_DESCRIPTION =
  "Send an alert or freeze the lease when it's spending faster than a set amount per hour or per day.";
const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export interface BudgetSettingsFormProps {
  /** Global maximum budget limit (optional) */
  globalMaxBudget?: number;
  /** Whether maximum budget is required by organization policy */
  requireMaxBudget: boolean;
  /** Whether this form edits a lease template or an individual lease */
  variant: SettingsFormVariant;
  /** The allowPredictiveBudgetControls global setting */
  allowPredictiveBudgetControls?: boolean;
  /**
   * The saved opt-in value on the template or lease edit page. Undefined when
   * creating a new template, where there is no saved value yet.
   */
  persistedPredictiveBudgetEnabled?: boolean;
  /** The allowBedrockTokenMonitoring global setting */
  allowBedrockTokenMonitoring?: boolean;
  /**
   * The template's or lease's current Sandbox Spaces value. While true, the
   * monitoring toggle cannot be edited.
   */
  sandboxSpacesEnabled?: boolean;
  /**
   * The saved Bedrock token monitoring value on the template or lease edit
   * page. Undefined when creating a new template, where there is no saved
   * value yet.
   */
  persistedBedrockTokenMonitoringEnabled?: boolean;
  /**
   * The lease duration in hours this budget applies to, for the short-lease
   * warning. Live form value on the wizard, the persisted value on the edit
   * pages; undefined when no duration is set.
   */
  leaseDurationInHours?: number;
}

/**
 * Reusable form component for budget settings.
 * Uses FormContext from parent - no internal state management.
 * Can be used in both lease templates and lease management.
 */
export function BudgetSettingsForm({
  globalMaxBudget,
  requireMaxBudget,
  variant,
  allowPredictiveBudgetControls = false,
  persistedPredictiveBudgetEnabled,
  allowBedrockTokenMonitoring = false,
  sandboxSpacesEnabled = false,
  persistedBedrockTokenMonitoringEnabled,
  leaseDurationInHours,
}: Readonly<BudgetSettingsFormProps>) {
  // Get control and trigger from form context
  const { control, trigger, watch, resetField } =
    useFormContext<BudgetSettingsFormValues>();

  // Watch form values for dynamic UI and cross-field validation
  const {
    maxBudgetEnabled,
    predictiveBudgetEnabled,
    bedrockTokenMonitoringEnabled,
  } = watch();

  // Handle dynamic threshold array with useFieldArray
  const { fields, append, remove } = useFieldArray({
    control,
    name: "budgetThresholds",
  });

  const {
    fields: rateLimitFields,
    append: appendRateLimit,
    remove: removeRateLimit,
  } = useFieldArray({
    control,
    name: "rateLimits",
  });

  // A template or lease already using the feature keeps a live toggle while the
  // global setting is off — it may only be switched off, which cannot be undone
  // until the global setting returns. One not using it gets a disabled toggle.
  const predictiveToggleDisabled =
    !allowPredictiveBudgetControls && !persistedPredictiveBudgetEnabled;

  // The global gate still has its one-way-off behavior. Sandbox Spaces adds a
  // stronger lock while it is enabled, regardless of the saved preference.
  const bedrockToggleDisabled =
    sandboxSpacesEnabled ||
    (!allowBedrockTokenMonitoring && !persistedBedrockTokenMonitoringEnabled);

  const predictiveActive = !!predictiveBudgetEnabled;

  const maxBudgetToggle = (
    <ToggleField
      controllerProps={{ control, name: "maxBudgetEnabled" }}
      valueToChecked={(value) => value || requireMaxBudget}
      formFieldProps={{
        label: "Maximum budget",
        description: requireMaxBudget
          ? `${MAXIMUM_BUDGET_DESCRIPTION} Your organization requires a maximum budget.`
          : MAXIMUM_BUDGET_DESCRIPTION,
      }}
      toggleProps={{
        children: maxBudgetEnabled || requireMaxBudget ? "Enabled" : "Disabled",
        disabled: requireMaxBudget,
        // Turning the toggle off puts back the starting maximum budget before
        // thresholds are checked again, since whether the maximum budget caps
        // them depends on the toggle.
        onChange: (event) => {
          if (!event.detail.checked) {
            resetField("maxSpend");
          }
          trigger("budgetThresholds");
        },
      }}
    />
  );

  const predictiveToggle = (
    <ToggleField
      controllerProps={{ control, name: "predictiveBudgetEnabled" }}
      formFieldProps={{
        label: "Estimated cost tracking",
        description: ESTIMATED_COST_TRACKING_DESCRIPTION,
      }}
      toggleProps={{
        children: predictiveBudgetEnabled ? "Enabled" : "Disabled",
        disabled: predictiveToggleDisabled,
        onChange: (event) => {
          if (!event.detail.checked) {
            resetField("rateLimits");
          }
          trigger("budgetThresholds");
        },
      }}
      toggleSuffix={globalGateIcon({
        featureName: "Estimated cost tracking",
        allowed: allowPredictiveBudgetControls,
        persistedEnabled: persistedPredictiveBudgetEnabled,
        enabled: predictiveBudgetEnabled,
        settingsArea: "Lease Policies",
        variant,
      })}
    />
  );

  const bedrockToggle = (
    <ToggleField
      controllerProps={{ control, name: "bedrockTokenMonitoringEnabled" }}
      formFieldProps={{
        label: "Amazon Bedrock token monitoring",
        description: BEDROCK_TOKEN_MONITORING_DESCRIPTION,
        constraintText: sandboxSpacesEnabled
          ? "Required while Sandbox Spaces is enabled."
          : undefined,
      }}
      toggleProps={{
        children: bedrockTokenMonitoringEnabled ? "Enabled" : "Disabled",
        disabled: bedrockToggleDisabled,
      }}
      toggleSuffix={
        sandboxSpacesEnabled
          ? undefined
          : globalGateIcon({
              featureName: "Amazon Bedrock token monitoring",
              allowed: allowBedrockTokenMonitoring,
              persistedEnabled: persistedBedrockTokenMonitoringEnabled,
              enabled: bedrockTokenMonitoringEnabled,
              settingsArea: "Lease Policies",
              variant,
            })
      }
    />
  );

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            info={
              <InfoLink
                markdown="cost-tracking"
                ariaLabel="Cost tracking help"
              />
            }
            description={
              <>
                {COST_TRACKING_DESCRIPTION}{" "}
                <Link external href={COST_DETAILS_URL}>
                  Learn about costs
                </Link>
              </>
            }
          >
            Cost tracking
          </Header>
        }
      >
        <SpaceBetween size="l">
          <ColumnLayout columns={2} variant="default">
            {predictiveToggle}
            {bedrockToggle}
          </ColumnLayout>
          <PredictiveDurationWarning
            predictiveBudgetEnabled={predictiveActive}
            durationHours={leaseDurationInHours}
            variant={variant}
          />
        </SpaceBetween>
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            info={
              <InfoLink
                markdown="budget-threshold-trigger"
                ariaLabel="Budget thresholds help"
              />
            }
            description={BUDGET_THRESHOLDS_DESCRIPTION}
          >
            Budget thresholds
          </Header>
        }
      >
        <SpaceBetween size="l">
          {maxBudgetToggle}

          {!maxBudgetEnabled && !requireMaxBudget && (
            <Alert type="warning">
              Without a maximum budget, accounts may incur unexpected costs.
              Consider setting a maximum budget.
            </Alert>
          )}

          {(fields.length > 0 || maxBudgetEnabled || requireMaxBudget) && (
            <ColumnLayout columns={4} variant="default">
              <Box variant="awsui-key-label" color="text-body-secondary">
                Amount (USD)
              </Box>
              <Box variant="awsui-key-label" color="text-body-secondary">
                Action
              </Box>
              <Box variant="awsui-key-label" color="text-body-secondary">
                Cost basis
              </Box>
            </ColumnLayout>
          )}

          {fields.map((field, index) => (
            <ColumnLayout key={field.id} columns={4} variant="default">
              <InputField
                controllerProps={{
                  control,
                  name: `budgetThresholds.${index}.dollarsSpent` as const,
                }}
                formFieldProps={{}}
                min={0}
                inputProps={{
                  ariaLabel: `Threshold ${index + 1} amount (USD)`,
                  type: "number",
                  step: "any",
                  placeholder: "e.g., 25",
                  inputMode: "decimal",
                  // Re-run cross-field validation so an amount above Maximum
                  // Spend surfaces its error live, not only when maximum budget changes.
                  onChange: () => trigger(),
                }}
              />

              <SelectField
                controllerProps={{
                  control,
                  name: `budgetThresholds.${index}.action` as const,
                }}
                selectProps={{
                  ariaLabel: `Threshold ${index + 1} action`,
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

              {predictiveActive ? (
                <SelectField
                  controllerProps={{
                    control,
                    name: `budgetThresholds.${index}.triggerOn` as const,
                  }}
                  selectProps={{
                    ariaLabel: `Threshold ${index + 1} cost basis`,
                    options: TRIGGER_ON_OPTIONS,
                    // Absent means reported cost — today's behavior.
                    valueToOption: (value) =>
                      TRIGGER_ON_OPTIONS.find((opt) => opt.value === value) ??
                      TRIGGER_ON_OPTIONS[0],
                    optionToValue: (option) =>
                      option?.value as "REPORTED" | "PREDICTED" | undefined,
                    onChange: () => trigger(),
                  }}
                />
              ) : (
                // Without predictive controls every threshold triggers on
                // reported cost; keep the column so the grid never shifts.
                <FormField>
                  <Select
                    ariaLabel={`Threshold ${index + 1} cost basis`}
                    selectedOption={{
                      label: "Reported cost",
                      value: "REPORTED",
                    }}
                    disabled
                  />
                </FormField>
              )}

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

          {(maxBudgetEnabled || requireMaxBudget) && (
            <ColumnLayout columns={4} variant="default">
              <InputField
                controllerProps={{ control, name: "maxSpend" }}
                min={0}
                max={globalMaxBudget}
                formFieldProps={{
                  constraintText:
                    globalMaxBudget === undefined
                      ? undefined
                      : `Must be ${USD_FORMATTER.format(globalMaxBudget)} or less.`,
                }}
                inputProps={{
                  type: "number",
                  step: "any",
                  placeholder: "e.g., 50",
                  inputMode: "decimal",
                  ariaLabel: "Maximum budget amount (USD)",
                  onChange: () => trigger(),
                }}
              />
              <FormField>
                <Select
                  ariaLabel="Maximum budget action"
                  selectedOption={{
                    label: "Terminate lease",
                    value: "TERMINATE",
                  }}
                  disabled
                />
              </FormField>
              <FormField>
                <Select
                  ariaLabel="Maximum budget cost basis"
                  selectedOption={{
                    label: "Current cost",
                    value: "CURRENT",
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
            Add threshold
          </Button>
        </SpaceBetween>
      </Container>

      {predictiveActive && (
        <Container
          header={
            <Header
              variant="h2"
              info={
                <InfoLink
                  markdown="spend-rate-limits"
                  ariaLabel="Spend rate thresholds help"
                />
              }
              description={SPEND_RATE_THRESHOLDS_DESCRIPTION}
            >
              Spend rate thresholds
            </Header>
          }
        >
          <SpaceBetween size="l">
            {rateLimitFields.length > 0 && (
              <ColumnLayout columns={4} variant="default">
                <Box variant="awsui-key-label" color="text-body-secondary">
                  Rate (USD)
                </Box>
                <Box variant="awsui-key-label" color="text-body-secondary">
                  Period
                </Box>
                <Box variant="awsui-key-label" color="text-body-secondary">
                  Action
                </Box>
              </ColumnLayout>
            )}

            {rateLimitFields.map((field, index) => (
              <ColumnLayout key={field.id} columns={4} variant="default">
                <InputField
                  controllerProps={{
                    control,
                    name: `rateLimits.${index}.rate` as const,
                  }}
                  formFieldProps={{}}
                  min={0}
                  inputProps={{
                    type: "number",
                    step: "any",
                    placeholder: "e.g., 12",
                    inputMode: "decimal",
                    ariaLabel: `Rate threshold ${index + 1} rate (USD)`,
                    // Re-run cross-row validation so a duplicate surfaces live.
                    onChange: () => trigger("rateLimits"),
                  }}
                />
                <SelectField
                  controllerProps={{
                    control,
                    name: `rateLimits.${index}.basis` as const,
                  }}
                  selectProps={{
                    ariaLabel: `Rate threshold ${index + 1} period`,
                    placeholder: "Choose a period",
                    options: RATE_PERIOD_OPTIONS,
                    valueToOption: (value) =>
                      RATE_PERIOD_OPTIONS.find((opt) => opt.value === value) ||
                      null,
                    optionToValue: (option) =>
                      option?.value as "HOURLY" | "DAILY" | undefined,
                    onChange: () => trigger("rateLimits"),
                  }}
                />
                <SelectField
                  controllerProps={{
                    control,
                    name: `rateLimits.${index}.action` as const,
                  }}
                  selectProps={{
                    ariaLabel: `Rate threshold ${index + 1} action`,
                    placeholder: "Choose an action",
                    options: THRESHOLD_ACTION_OPTIONS,
                    valueToOption: (value) =>
                      THRESHOLD_ACTION_OPTIONS.find(
                        (opt) => opt.value === value,
                      ) || null,
                    optionToValue: (option) =>
                      option?.value as "ALERT" | "FREEZE_ACCOUNT" | undefined,
                  }}
                />
                <Button
                  variant="normal"
                  formAction="none"
                  onClick={() => {
                    removeRateLimit(index);
                    trigger("rateLimits");
                  }}
                  ariaLabel={`Remove rate threshold ${index + 1}`}
                >
                  Remove
                </Button>
              </ColumnLayout>
            ))}

            <Button
              iconName="add-plus"
              formAction="none"
              disabled={
                rateLimitFields.length >= RATE_LIMIT_CONSTRAINTS.MAX_ENTRIES
              }
              onClick={() => {
                appendRateLimit({
                  rate: "",
                  basis: "HOURLY",
                  action: "ALERT",
                });
              }}
            >
              Add rate threshold
            </Button>
          </SpaceBetween>
        </Container>
      )}
    </SpaceBetween>
  );
}
