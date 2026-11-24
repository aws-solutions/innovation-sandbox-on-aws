// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Container, Header, SpaceBetween } from "@cloudscape-design/components";

import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import TokenListField from "@amzn/innovation-sandbox-frontend/components/FormFields/TokenListField";
import {
  type FormFieldDefinitions,
  formSearchFields,
  settingAnchor,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import {
  CONFIG_BOUNDS,
  type ConfigSectionWriteFields,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { SectionForm } from "./SectionForm";
import { SettingAnchor } from "./SettingAnchor";

const fields = {
  requireCostReportGroup: {
    label: "Require cost report group",
    description:
      "Every lease template must pick a cost report group. Existing templates without one aren't changed until edited.",
  },
  costReportGroups: {
    label: "Cost report groups",
    description:
      "Groups managers can choose from in a lease template. Removing a group doesn't change leases or templates already using it; it just can't be picked again.",
  },
} satisfies FormFieldDefinitions<"costReporting">;

export const costReportingFormSearchFields = formSearchFields({
  section: "costReporting",
  group: "cost",
  subgroup: "Cost report groups",
  fields,
});

function CostReportingFormFields({
  readOnly,
}: Readonly<{ readOnly: boolean }>) {
  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description={
              "Labels that attribute a lease's spend to a team or project in cost reports."
            }
          >
            Cost report groups
          </Header>
        }
      >
        <SpaceBetween size="l">
          <SettingAnchor
            id={settingAnchor("costReporting", "requireCostReportGroup")}
          >
            <ToggleField<ConfigSectionWriteFields<"costReporting">>
              toggleProps={{ readOnly }}
              controllerProps={{
                name: "requireCostReportGroup",
                rules: { deps: "costReportGroups" },
              }}
              formFieldProps={{
                ...fields.requireCostReportGroup,
                stretch: true,
              }}
              stateLabel
            />
          </SettingAnchor>
          <SettingAnchor
            id={settingAnchor("costReporting", "costReportGroups")}
          >
            <TokenListField
              controllerProps={{ name: "costReportGroups" }}
              formFieldProps={fields.costReportGroups}
              inputProps={{
                readOnly,
                placeholder: "Add a group",
              }}
              sorted
              itemNoun="groups"
              maxItems={CONFIG_BOUNDS.MAX_COST_REPORT_GROUPS}
              maxItemLength={CONFIG_BOUNDS.MAX_COST_REPORT_GROUP_LENGTH}
            />
          </SettingAnchor>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
export function CostReportingForm() {
  return (
    <SectionForm
      section="costReporting"
      renderFields={(readOnly) => (
        <CostReportingFormFields readOnly={readOnly} />
      )}
    />
  );
}
