// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  ColumnLayout,
  Container,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useWatch } from "react-hook-form";

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import {
  type FormFieldDefinitions,
  formSearchFields,
  settingAnchor,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import { CONFIG_BOUNDS } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { SectionForm } from "./SectionForm";
import { SettingAnchor } from "./SettingAnchor";

const emailFields = {
  sesEnabled: {
    label: "Email notifications (SES)",
    description:
      "Enable email delivery through Amazon Simple Email Service (SES).",
  },
  emailFrom: {
    label: "Email from address (SES)",
    description:
      "The sender address used for email notifications. The sending identity is set at deployment time by the SesIdentityArn CloudFormation parameter. Not used while SES is off.",
  },
} satisfies FormFieldDefinitions<"notification">;

const snsFields = {
  snsIntegrationTopicEnabled: {
    label: "SNS integration topic",
    description:
      "Publish notifications to the shared SNS integration topic for customer-owned downstream consumers.",
  },
} satisfies FormFieldDefinitions<"notification">;

export const notificationFormSearchFields = [
  ...formSearchFields({
    section: "notification",
    group: "notifications",
    subgroup: "Email",
    fields: emailFields,
  }),
  ...formSearchFields({
    section: "notification",
    group: "notifications",
    subgroup: "Amazon SNS",
    fields: snsFields,
  }),
];

function NotificationFormFields({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const [sesEnabled, snsEnabled, emailFrom] = useWatch({
    name: ["sesEnabled", "snsIntegrationTopicEnabled", "emailFrom"],
  });
  return (
    <SpaceBetween size="l">
      {!snsEnabled && (!sesEnabled || !String(emailFrom).trim()) && (
        <Alert type="warning" header="All notifications are off">
          Users and managers won't be told about approvals, budget thresholds or
          expiring leases.
        </Alert>
      )}
      <Container
        header={
          <Header variant="h2" description={""}>
            Email
          </Header>
        }
      >
        <ColumnLayout columns={2}>
          <SettingAnchor id={settingAnchor("notification", "sesEnabled")}>
            <ToggleField
              toggleProps={{ readOnly }}
              controllerProps={{ name: "sesEnabled" }}
              formFieldProps={{
                ...emailFields.sesEnabled,
                stretch: true,
              }}
              stateLabel
            />
          </SettingAnchor>
          <SettingAnchor id={settingAnchor("notification", "emailFrom")}>
            <InputField
              controllerProps={{ name: "emailFrom" }}
              formFieldProps={{
                ...emailFields.emailFrom,
                constraintText: `Maximum ${CONFIG_BOUNDS.MAX_EMAIL_LENGTH} characters`,
              }}
              inputProps={{
                readOnly,
                type: "email",
                placeholder: "e.g., no-reply@example.com",
              }}
            />
          </SettingAnchor>
        </ColumnLayout>
      </Container>
      <Container
        header={
          <Header variant="h2" description={""}>
            Amazon SNS
          </Header>
        }
      >
        <SettingAnchor
          id={settingAnchor("notification", "snsIntegrationTopicEnabled")}
        >
          <ToggleField
            toggleProps={{ readOnly }}
            controllerProps={{
              name: "snsIntegrationTopicEnabled",
            }}
            formFieldProps={{
              ...snsFields.snsIntegrationTopicEnabled,
              stretch: true,
            }}
            stateLabel
          />
        </SettingAnchor>
      </Container>
    </SpaceBetween>
  );
}
export function NotificationForm() {
  return (
    <SectionForm
      section="notification"
      renderFields={(readOnly) => (
        <NotificationFormFields readOnly={readOnly} />
      )}
    />
  );
}
