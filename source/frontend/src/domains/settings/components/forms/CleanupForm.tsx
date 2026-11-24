// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Badge,
  ColumnLayout,
  Container,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useWatch } from "react-hook-form";

import NumberField from "@amzn/innovation-sandbox-frontend/components/FormFields/NumberField";
import RadioGroupField from "@amzn/innovation-sandbox-frontend/components/FormFields/RadioGroupField";
import {
  type FormFieldDefinitions,
  formSearchFields,
  settingAnchor,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import { CONFIG_BOUNDS } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { SectionForm } from "./SectionForm";
import { SettingAnchor } from "./SettingAnchor";

const cleanupAttemptFields = {
  numberOfFailedAttemptsToCancelCleanup: {
    label: "Failed attempts before quarantine",
    description:
      "After this many failed cleanup runs the account is quarantined for manual review.",
  },
  waitBeforeRetryFailedAttemptSeconds: {
    label: "Wait before retry (seconds)",
    description: "Delay between failed cleanup runs.",
  },
  numberOfSuccessfulAttemptsToFinishCleanup: {
    label: "Successful attempts to finish",
    description:
      "Successful cleanup runs required before the account returns to the available pool.",
  },
  waitBeforeRerunSuccessfulAttemptSeconds: {
    label: "Wait before rerun (seconds)",
    description: "Delay between successful cleanup runs.",
  },
} satisfies FormFieldDefinitions<"cleanup">;

const lifecycleFields = {
  cooldownPeriodHours: {
    label: "Account cooldown (hours)",
    description:
      "Time an account waits after cleanup before it can be leased again. Set to 0 for no cooldown.",
  },
} satisfies FormFieldDefinitions<"cleanup">;

const retentionFields = {
  reportRetentionDays: {
    label: "Cleanup report retention (days)",
    description: "How long cleanup reports are kept before they are deleted.",
  },
} satisfies FormFieldDefinitions<"cleanup">;

const validationFields = {
  "validation.failureAction": {
    label: "On validation failure",
    description:
      "Silent returns the account without a warning. Warn logs remaining resources. Quarantine moves the account for manual review.",
  },
} satisfies FormFieldDefinitions<"cleanup">;

export const cleanupFormSearchFields = [
  ...formSearchFields({
    section: "cleanup",
    group: "account-cleanup",
    subgroup: "Cleanup attempts",
    fields: cleanupAttemptFields,
  }),
  ...formSearchFields({
    section: "cleanup",
    group: "account-cleanup",
    subgroup: "Account lifecycle",
    fields: lifecycleFields,
  }),
  ...formSearchFields({
    section: "cleanup",
    group: "account-cleanup",
    subgroup: "Data retention",
    fields: retentionFields,
  }),
  ...formSearchFields({
    section: "cleanup",
    group: "account-cleanup",
    subgroup: "Cleanup validation",
    fields: validationFields,
  }),
];

function CooldownAdvice({
  action,
  cooldown,
}: {
  action: string;
  cooldown: number;
}) {
  return (action === "Warn" || action === "Quarantine") && cooldown < 168 ? (
    <Alert type="warning">
      When choosing Warn or Quarantine, set the account cooldown to at least 168
      hours (7 days). Resource Explorer can take time to reflect deleted
      resources, so a shorter cooldown may flag resources that are already
      cleaned up.
    </Alert>
  ) : null;
}
function WatchedCooldownAdvice() {
  const [action, cooldown] = useWatch({
    name: ["validation.failureAction", "cooldownPeriodHours"],
  });
  return <CooldownAdvice action={action} cooldown={cooldown} />;
}

function CleanupFormFields({ readOnly }: Readonly<{ readOnly: boolean }>) {
  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description={
              "Accounts are wiped with AWS Nuke after a lease ends. These settings control retries and apply to cleanups that start after saving."
            }
          >
            Cleanup attempts
          </Header>
        }
      >
        <ColumnLayout columns={2}>
          <SettingAnchor
            id={settingAnchor(
              "cleanup",
              "numberOfFailedAttemptsToCancelCleanup",
            )}
          >
            <NumberField
              inputProps={{ readOnly }}
              controllerProps={{
                name: "numberOfFailedAttemptsToCancelCleanup",
              }}
              formFieldProps={{
                ...cleanupAttemptFields.numberOfFailedAttemptsToCancelCleanup,
                constraintText: `Minimum ${CONFIG_BOUNDS.MIN_CLEANUP_VALUE}`,
              }}
              min={CONFIG_BOUNDS.MIN_CLEANUP_VALUE}
            />
          </SettingAnchor>
          <SettingAnchor
            id={settingAnchor("cleanup", "waitBeforeRetryFailedAttemptSeconds")}
          >
            <NumberField
              inputProps={{ readOnly }}
              controllerProps={{
                name: "waitBeforeRetryFailedAttemptSeconds",
              }}
              formFieldProps={{
                ...cleanupAttemptFields.waitBeforeRetryFailedAttemptSeconds,
                constraintText: `Minimum ${CONFIG_BOUNDS.MIN_CLEANUP_VALUE}`,
              }}
              min={CONFIG_BOUNDS.MIN_CLEANUP_VALUE}
            />
          </SettingAnchor>
          <SettingAnchor
            id={settingAnchor(
              "cleanup",
              "numberOfSuccessfulAttemptsToFinishCleanup",
            )}
          >
            <NumberField
              inputProps={{ readOnly }}
              controllerProps={{
                name: "numberOfSuccessfulAttemptsToFinishCleanup",
              }}
              formFieldProps={{
                ...cleanupAttemptFields.numberOfSuccessfulAttemptsToFinishCleanup,
                constraintText: `Minimum ${CONFIG_BOUNDS.MIN_CLEANUP_VALUE}`,
              }}
              min={CONFIG_BOUNDS.MIN_CLEANUP_VALUE}
            />
          </SettingAnchor>
          <SettingAnchor
            id={settingAnchor(
              "cleanup",
              "waitBeforeRerunSuccessfulAttemptSeconds",
            )}
          >
            <NumberField
              inputProps={{ readOnly }}
              controllerProps={{
                name: "waitBeforeRerunSuccessfulAttemptSeconds",
              }}
              formFieldProps={{
                ...cleanupAttemptFields.waitBeforeRerunSuccessfulAttemptSeconds,
                constraintText: `Minimum ${CONFIG_BOUNDS.MIN_CLEANUP_VALUE}`,
              }}
              min={CONFIG_BOUNDS.MIN_CLEANUP_VALUE}
            />
          </SettingAnchor>
        </ColumnLayout>
      </Container>
      <Container
        header={
          <Header
            variant="h2"
            description={"What happens to an account after a successful wipe."}
          >
            Account lifecycle
          </Header>
        }
      >
        <SettingAnchor id={settingAnchor("cleanup", "cooldownPeriodHours")}>
          <NumberField
            inputProps={{ readOnly }}
            controllerProps={{ name: "cooldownPeriodHours" }}
            formFieldProps={{
              ...lifecycleFields.cooldownPeriodHours,
              constraintText: `${CONFIG_BOUNDS.MIN_COOLDOWN_PERIOD_HOURS.toLocaleString("en-US")} to ${CONFIG_BOUNDS.MAX_COOLDOWN_PERIOD_HOURS.toLocaleString("en-US")}`,
            }}
            min={CONFIG_BOUNDS.MIN_COOLDOWN_PERIOD_HOURS}
            max={CONFIG_BOUNDS.MAX_COOLDOWN_PERIOD_HOURS}
          />
        </SettingAnchor>
      </Container>
      <Container
        header={
          <Header
            variant="h2"
            description={"How long cleanup records are kept."}
          >
            Data retention
          </Header>
        }
      >
        <SettingAnchor id={settingAnchor("cleanup", "reportRetentionDays")}>
          <NumberField
            inputProps={{ readOnly }}
            controllerProps={{ name: "reportRetentionDays" }}
            formFieldProps={{
              ...retentionFields.reportRetentionDays,
              constraintText: `${CONFIG_BOUNDS.MIN_REPORT_RETENTION_DAYS.toLocaleString("en-US")} to ${CONFIG_BOUNDS.MAX_REPORT_RETENTION_DAYS.toLocaleString("en-US")}`,
            }}
            min={CONFIG_BOUNDS.MIN_REPORT_RETENTION_DAYS}
            max={CONFIG_BOUNDS.MAX_REPORT_RETENTION_DAYS}
          />
        </SettingAnchor>
      </Container>
      <Container
        header={
          <Header
            variant="h2"
            description={
              "After cleanup, Innovation Sandbox checks the account for remaining resources with AWS Resource Explorer. Choose what happens if it finds any."
            }
            actions={<Badge color="blue">Experimental</Badge>}
          >
            Cleanup validation
          </Header>
        }
      >
        <SpaceBetween size="m">
          <SettingAnchor
            id={settingAnchor("cleanup", "validation.failureAction")}
          >
            <RadioGroupField
              controllerProps={{
                name: "validation.failureAction",
              }}
              formFieldProps={{
                ...validationFields["validation.failureAction"],
                description: "",
                stretch: true,
              }}
              radioGroupProps={{
                readOnly,
                items: [
                  {
                    value: "Silent",
                    label: "Silent",
                    description:
                      "Return the account to available without raising a warning.",
                  },
                  {
                    value: "Warn",
                    label: "Warn",
                    description:
                      "Log a warning and surface remaining resources, but return the account to available.",
                  },
                  {
                    value: "Quarantine",
                    label: "Quarantine",
                    description:
                      "Move the account to quarantine for manual review.",
                  },
                ],
              }}
            />
          </SettingAnchor>
          <WatchedCooldownAdvice />
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
export function CleanupForm() {
  return (
    <SectionForm
      section="cleanup"
      renderFields={(readOnly) => <CleanupFormFields readOnly={readOnly} />}
    />
  );
}
