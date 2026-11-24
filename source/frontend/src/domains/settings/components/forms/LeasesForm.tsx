// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ColumnLayout,
  Container,
  FormField,
  Header,
  Input,
  SpaceBetween,
} from "@cloudscape-design/components";
import { Controller, useFormContext, useWatch } from "react-hook-form";

import NumberField from "@amzn/innovation-sandbox-frontend/components/FormFields/NumberField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import {
  ConfigurationFieldName,
  type FormFieldDefinitions,
  formSearchFields,
  settingAnchor,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import {
  CONFIG_BOUNDS,
  type ConfigSectionWriteFields,
  GroupAssignmentMode,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { SectionForm } from "./SectionForm";
import { SettingAnchor } from "./SettingAnchor";

const BEDROCK_TOKEN_MONITORING_ANCHOR = settingAnchor(
  "leases",
  "allowBedrockTokenMonitoring",
);
export const BEDROCK_TOKEN_MONITORING_HREF = `/settings#${BEDROCK_TOKEN_MONITORING_ANCHOR}`;

const budgetAndDurationFields = {
  requireMaxBudget: {
    label: "Require max budget",
    description:
      "Every lease template must set a maximum budget. Applies when templates are created or edited; existing templates aren't changed.",
  },
  maxBudget: {
    label: "Max budget",
    description:
      "The highest budget a lease template may set. Templates and leases already above a new value keep their budget until edited.",
  },
  requireMaxDuration: {
    label: "Require max duration",
    description:
      "Every lease template must set a maximum duration. Applies when templates are created or edited; existing templates aren't changed.",
  },
  maxDurationHours: {
    label: "Max lease duration",
    description:
      "The longest duration a lease template may set. Templates and leases already above a new value keep their duration until edited.",
  },
} satisfies FormFieldDefinitions<"leases">;

const costTrackingFields = {
  allowPredictiveBudgetControls: {
    label: "Allow estimated cost tracking",
    description:
      "When enabled, lease templates may turn on estimated cost tracking.",
  },
  allowBedrockTokenMonitoring: {
    label: "Allow Bedrock token monitoring",
    description:
      "When enabled, lease templates may turn on Bedrock token monitoring, which prices each lease's Amazon Bedrock token usage before AWS Cost Explorer bills it. Leases with a Sandbox Space always use it to count agent spend, even when this is disabled.",
  },
} satisfies FormFieldDefinitions<"leases">;

const leaseLimitFields = {
  maxLeaseRequestsPerWindow: {
    label: "Lease request rate limit",
    description:
      "How many lease requests a user can make in a rolling period before further requests are rejected.",
  },
  maxLeasesPerUser: {
    label: "Max leases per user",
    description:
      "Active leases and pending lease requests a single user can have at once. Users already above a new limit keep their leases; new requests are blocked.",
  },
} satisfies FormFieldDefinitions<"leases">;

const leaseAccessFields = {
  leaseSharingEnabled: {
    label: "Allow lease sharing",
    description:
      "Lets lease owners share sandbox access with other users. Templates can still turn this off individually. Admins and managers always retain access.",
  },
  groupAssignmentMode: {
    label: "Allow group assignments",
    description:
      "Lets leases be assigned to IAM Identity Center groups. Existing group assignments keep working when this is off and can still be removed. Group search and lookup are unavailable while this is off.",
  },
  enablePrincipalSearch: {
    label: "Principal search",
    description:
      "Shows a typeahead of Identity Center users when assigning or sharing a lease. When off, it's unavailable to all roles and users must be entered exactly.",
  },
  allowUserLeaseTermination: {
    label: "Allow users to terminate their own leases",
    description: "When off, only managers and admins can terminate a lease.",
  },
} satisfies FormFieldDefinitions<"leases">;

const retentionFields = {
  ttl: {
    label: "Lease record retention (days)",
    description:
      "How long ended leases stay in the Leases list before the record is deleted (deletion can take up to 48 hours).",
  },
} satisfies FormFieldDefinitions<"leases">;

const costMonitoringFields = {
  serviceBreakdownEnabled: {
    label: "Enable service cost breakdown",
    description:
      "Collects a per-service cost breakdown with each cost observation, powering service-level spend insights in notifications and the lease cost panel.",
  },
} satisfies FormFieldDefinitions<"leases">;

export const leasesFormSearchFields = [
  ...formSearchFields({
    section: "leases",
    group: "lease-policies",
    subgroup: "Budget and duration",
    fields: budgetAndDurationFields,
  }),
  ...formSearchFields({
    section: "leases",
    group: "lease-policies",
    subgroup: "Cost tracking",
    fields: costTrackingFields,
  }),
  ...formSearchFields({
    section: "leases",
    group: "lease-policies",
    subgroup: "Lease limits",
    fields: leaseLimitFields,
  }),
  ...formSearchFields({
    section: "leases",
    group: "lease-policies",
    subgroup: "Lease access",
    fields: leaseAccessFields,
  }),
  ...formSearchFields({
    section: "leases",
    group: "lease-policies",
    subgroup: "Data retention",
    fields: retentionFields,
  }),
  ...formSearchFields({
    section: "leases",
    group: "cost",
    subgroup: "Cost monitoring",
    fields: costMonitoringFields,
  }),
];
const LEASE_REQUEST_WINDOW_FIELD =
  "leaseRequestWindowHours" satisfies ConfigurationFieldName<"leases">;

export const leasePolicyFields = [
  ...Object.keys(budgetAndDurationFields),
  ...Object.keys(costTrackingFields),
  ...Object.keys(leaseLimitFields),
  // The rate-limit control edits both values under one searchable label.
  LEASE_REQUEST_WINDOW_FIELD,
  ...Object.keys(leaseAccessFields),
  ...Object.keys(retentionFields),
];
export const costMonitoringFieldNames = Object.keys(costMonitoringFields);

function LeaseRequestRateLimit({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const {
    control,
    formState: { errors },
  } = useFormContext();
  const retentionDays = Number(useWatch({ name: "ttl" }));
  const message = [
    errors.maxLeaseRequestsPerWindow?.message,
    errors.leaseRequestWindowHours?.message,
  ]
    .filter((value) => typeof value === "string")
    .join("; ");
  return (
    <FormField
      {...leaseLimitFields.maxLeaseRequestsPerWindow}
      errorText={message || undefined}
      constraintText={`Minimum 1 request. Maximum period: ${(retentionDays * 24).toLocaleString("en-US")} hours, based on lease record retention of ${retentionDays.toLocaleString("en-US")} days.`}
    >
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <Controller
            name="maxLeaseRequestsPerWindow"
            control={control}
            render={({ field, fieldState }) => (
              <Input
                readOnly={readOnly}
                type="number"
                ariaLabel="Maximum lease requests"
                value={String(field.value)}
                invalid={!!fieldState.error}
                nativeInputAttributes={{
                  min: CONFIG_BOUNDS.MIN_LEASE_REQUESTS_PER_WINDOW,
                  style: { inlineSize: "10em" },
                }}
                onChange={({ detail }) =>
                  field.onChange(
                    detail.value === "" ? "" : Number(detail.value),
                  )
                }
                onBlur={field.onBlur}
                ref={field.ref}
              />
            )}
          />
          <span>requests</span>
        </SpaceBetween>
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <span>per</span>
          <Controller
            name={LEASE_REQUEST_WINDOW_FIELD}
            control={control}
            render={({ field, fieldState }) => (
              <div style={{ inlineSize: "10em" }}>
                <Input
                  readOnly={readOnly}
                  type="number"
                  ariaLabel="Lease request hour period"
                  value={String(field.value)}
                  invalid={!!fieldState.error}
                  nativeInputAttributes={{
                    min: CONFIG_BOUNDS.MIN_LEASE_REQUEST_WINDOW_HOURS,
                  }}
                  onChange={({ detail }) =>
                    field.onChange(
                      detail.value === "" ? "" : Number(detail.value),
                    )
                  }
                  onBlur={field.onBlur}
                  ref={field.ref}
                />
              </div>
            )}
          />
          <span>hours</span>
        </SpaceBetween>
      </SpaceBetween>
    </FormField>
  );
}

function LeasesFormFields({
  readOnly,
  group,
}: Readonly<{
  readOnly: boolean;
  group: "lease-policies" | "cost";
}>) {
  return (
    <SpaceBetween size="l">
      {group === "cost" ? (
        <Container
          header={
            <Header
              variant="h2"
              description={
                "Deployment-wide cost data collected alongside billing reports."
              }
            >
              Cost monitoring
            </Header>
          }
        >
          <SettingAnchor
            id={settingAnchor("leases", "serviceBreakdownEnabled")}
          >
            <ToggleField
              toggleProps={{ readOnly }}
              controllerProps={{
                name: "serviceBreakdownEnabled",
              }}
              formFieldProps={{
                ...costMonitoringFields.serviceBreakdownEnabled,
                stretch: true,
              }}
              stateLabel
            />
          </SettingAnchor>
        </Container>
      ) : (
        <SpaceBetween size="l">
          <Container
            header={
              <Header
                variant="h2"
                description={
                  "Ceilings that every lease template must stay within. Managers set the actual budget and duration per template."
                }
              >
                Budget and duration
              </Header>
            }
          >
            <ColumnLayout columns={2}>
              <SpaceBetween size="m">
                <SettingAnchor id={settingAnchor("leases", "requireMaxBudget")}>
                  <ToggleField
                    toggleProps={{ readOnly }}
                    controllerProps={{
                      name: "requireMaxBudget",
                    }}
                    formFieldProps={{
                      ...budgetAndDurationFields.requireMaxBudget,
                      stretch: true,
                    }}
                    stateLabel
                  />
                </SettingAnchor>
                <SettingAnchor id={settingAnchor("leases", "maxBudget")}>
                  <NumberField
                    inputProps={{ readOnly }}
                    controllerProps={{
                      name: "maxBudget",
                    }}
                    formFieldProps={{
                      ...budgetAndDurationFields.maxBudget,
                      constraintText: `${(0).toLocaleString("en-US")} to ${CONFIG_BOUNDS.MAX_BUDGET.toLocaleString("en-US")}`,
                    }}
                    min={0}
                    max={CONFIG_BOUNDS.MAX_BUDGET}
                  />
                </SettingAnchor>
              </SpaceBetween>
              <SpaceBetween size="m">
                <SettingAnchor
                  id={settingAnchor("leases", "requireMaxDuration")}
                >
                  <ToggleField
                    toggleProps={{ readOnly }}
                    controllerProps={{
                      name: "requireMaxDuration",
                    }}
                    formFieldProps={{
                      ...budgetAndDurationFields.requireMaxDuration,
                      stretch: true,
                    }}
                    stateLabel
                  />
                </SettingAnchor>
                <SettingAnchor id={settingAnchor("leases", "maxDurationHours")}>
                  <NumberField
                    inputProps={{ readOnly }}
                    controllerProps={{
                      name: "maxDurationHours",
                    }}
                    formFieldProps={{
                      ...budgetAndDurationFields.maxDurationHours,
                      constraintText: `${(0).toLocaleString("en-US")} to ${CONFIG_BOUNDS.MAX_DURATION_HOURS.toLocaleString("en-US")}`,
                    }}
                    min={0}
                    max={CONFIG_BOUNDS.MAX_DURATION_HOURS}
                  />
                </SettingAnchor>
              </SpaceBetween>
            </ColumnLayout>
          </Container>
          <Container
            header={
              <Header
                variant="h2"
                description={
                  "Enhanced cost tracking options lease templates may turn on. These features slightly increase the solution's operating cost, depending on how many leases use them."
                }
              >
                Cost tracking
              </Header>
            }
          >
            <ColumnLayout columns={2}>
              <SettingAnchor
                id={settingAnchor("leases", "allowPredictiveBudgetControls")}
              >
                <ToggleField
                  toggleProps={{ readOnly }}
                  controllerProps={{
                    name: "allowPredictiveBudgetControls",
                  }}
                  formFieldProps={{
                    ...costTrackingFields.allowPredictiveBudgetControls,
                    stretch: true,
                  }}
                  stateLabel
                />
              </SettingAnchor>
              <SettingAnchor id={BEDROCK_TOKEN_MONITORING_ANCHOR}>
                <ToggleField
                  toggleProps={{ readOnly }}
                  controllerProps={{
                    name: "allowBedrockTokenMonitoring",
                  }}
                  formFieldProps={{
                    ...costTrackingFields.allowBedrockTokenMonitoring,
                    stretch: true,
                  }}
                  stateLabel
                />
              </SettingAnchor>
            </ColumnLayout>
          </Container>
          <Container
            header={
              <Header
                variant="h2"
                description={
                  "How many leases a user can hold and how quickly they can request them."
                }
              >
                Lease limits
              </Header>
            }
          >
            <ColumnLayout columns={2}>
              <SettingAnchor
                id={settingAnchor("leases", "maxLeaseRequestsPerWindow")}
              >
                <LeaseRequestRateLimit readOnly={readOnly} />
              </SettingAnchor>
              <SettingAnchor id={settingAnchor("leases", "maxLeasesPerUser")}>
                <NumberField
                  inputProps={{ readOnly }}
                  controllerProps={{
                    name: "maxLeasesPerUser",
                  }}
                  formFieldProps={{
                    ...leaseLimitFields.maxLeasesPerUser,
                    constraintText: `Minimum ${CONFIG_BOUNDS.MIN_LEASES_PER_USER}`,
                  }}
                  min={CONFIG_BOUNDS.MIN_LEASES_PER_USER}
                />
              </SettingAnchor>
            </ColumnLayout>
          </Container>
          <Container
            header={
              <Header
                variant="h2"
                description={
                  "Who can be given access to a lease, and what owners can do with it."
                }
              >
                Lease access
              </Header>
            }
          >
            <ColumnLayout columns={2}>
              <SettingAnchor
                id={settingAnchor("leases", "leaseSharingEnabled")}
              >
                <ToggleField
                  toggleProps={{ readOnly }}
                  controllerProps={{
                    name: "leaseSharingEnabled",
                  }}
                  formFieldProps={{
                    ...leaseAccessFields.leaseSharingEnabled,
                    stretch: true,
                  }}
                  stateLabel
                />
              </SettingAnchor>
              <SettingAnchor
                id={settingAnchor("leases", "groupAssignmentMode")}
              >
                <ToggleField
                  toggleProps={{ readOnly }}
                  controllerProps={{
                    name: "groupAssignmentMode",
                  }}
                  formFieldProps={{
                    ...leaseAccessFields.groupAssignmentMode,
                    stretch: true,
                  }}
                  stateLabel
                  valueToChecked={(value) => value === GroupAssignmentMode.ALL}
                  checkedToValue={(checked) =>
                    checked ? GroupAssignmentMode.ALL : GroupAssignmentMode.NONE
                  }
                />
              </SettingAnchor>
              <SettingAnchor
                id={settingAnchor("leases", "enablePrincipalSearch")}
              >
                <ToggleField
                  toggleProps={{ readOnly }}
                  controllerProps={{
                    name: "enablePrincipalSearch",
                  }}
                  formFieldProps={{
                    ...leaseAccessFields.enablePrincipalSearch,
                    stretch: true,
                  }}
                  stateLabel
                />
              </SettingAnchor>
              <SettingAnchor
                id={settingAnchor("leases", "allowUserLeaseTermination")}
              >
                <ToggleField
                  toggleProps={{ readOnly }}
                  controllerProps={{
                    name: "allowUserLeaseTermination",
                  }}
                  formFieldProps={{
                    ...leaseAccessFields.allowUserLeaseTermination,
                    stretch: true,
                  }}
                  stateLabel
                />
              </SettingAnchor>
            </ColumnLayout>
          </Container>
          <Container
            header={
              <Header
                variant="h2"
                description={
                  "How long lease records are kept after a lease ends."
                }
              >
                Data retention
              </Header>
            }
          >
            <SettingAnchor id={settingAnchor("leases", "ttl")}>
              <NumberField<ConfigSectionWriteFields<"leases">>
                inputProps={{ readOnly }}
                controllerProps={{
                  name: "ttl",
                  rules: { deps: LEASE_REQUEST_WINDOW_FIELD },
                }}
                formFieldProps={{
                  ...retentionFields.ttl,
                  constraintText: `${CONFIG_BOUNDS.MIN_TTL_DAYS.toLocaleString("en-US")} to ${CONFIG_BOUNDS.MAX_TTL_DAYS.toLocaleString("en-US")}`,
                }}
                min={CONFIG_BOUNDS.MIN_TTL_DAYS}
                max={CONFIG_BOUNDS.MAX_TTL_DAYS}
              />
            </SettingAnchor>
          </Container>
        </SpaceBetween>
      )}
    </SpaceBetween>
  );
}
export function LeasesForm({
  group,
}: Readonly<{ group: "lease-policies" | "cost" }>) {
  return (
    <SectionForm
      section="leases"
      renderFields={(readOnly) => (
        <LeasesFormFields readOnly={readOnly} group={group} />
      )}
    />
  );
}
