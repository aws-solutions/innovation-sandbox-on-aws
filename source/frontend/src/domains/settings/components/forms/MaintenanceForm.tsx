// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Container, Header, SpaceBetween } from "@cloudscape-design/components";

import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import {
  type FormFieldDefinitions,
  formSearchFields,
  settingAnchor,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";

import { SectionForm } from "./SectionForm";
import { SettingAnchor } from "./SettingAnchor";

const fields = {
  enabled: {
    label: "Maintenance mode",
    description:
      "When on, managers and users can't use Innovation Sandbox and see a maintenance banner. Admins keep full access. Existing sandbox accounts keep running.",
  },
} satisfies FormFieldDefinitions<"maintenance">;

export const maintenanceFormSearchFields = formSearchFields({
  section: "maintenance",
  group: "general",
  subgroup: "Maintenance mode",
  fields,
});
const MAINTENANCE_MODE_ANCHOR = settingAnchor("maintenance", "enabled");
export const MAINTENANCE_MODE_HREF = `/settings#${MAINTENANCE_MODE_ANCHOR}`;

function MaintenanceFormFields({ readOnly }: Readonly<{ readOnly: boolean }>) {
  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description={
              "Locks managers and users out of Innovation Sandbox while you make changes to the deployment."
            }
          >
            Maintenance mode
          </Header>
        }
      >
        <SettingAnchor id={MAINTENANCE_MODE_ANCHOR}>
          <ToggleField
            toggleProps={{ readOnly }}
            controllerProps={{ name: "enabled" }}
            formFieldProps={{
              ...fields.enabled,
              stretch: true,
            }}
            stateLabel
          />
        </SettingAnchor>
      </Container>
    </SpaceBetween>
  );
}
export function MaintenanceForm() {
  return (
    <SectionForm
      section="maintenance"
      renderFields={(readOnly) => <MaintenanceFormFields readOnly={readOnly} />}
    />
  );
}
