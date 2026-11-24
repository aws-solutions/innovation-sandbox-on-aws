// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Container, Header, SpaceBetween } from "@cloudscape-design/components";

import TextareaField from "@amzn/innovation-sandbox-frontend/components/FormFields/TextareaField";
import {
  type FormFieldDefinitions,
  formSearchFields,
  settingAnchor,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import { CONFIG_BOUNDS } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { SectionForm } from "./SectionForm";
import { SettingAnchor } from "./SettingAnchor";

const fields = {
  content: {
    label: "Terms of service content",
    description: "",
  },
} satisfies FormFieldDefinitions<"termsOfService">;

export const termsOfServiceFormSearchFields = formSearchFields({
  section: "termsOfService",
  group: "general",
  subgroup: "Terms of service",
  fields,
});

function TermsOfServiceFormFields({
  readOnly,
}: Readonly<{ readOnly: boolean }>) {
  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description={"Shown to users when they request a lease."}
          >
            Terms of service
          </Header>
        }
      >
        <SettingAnchor id={settingAnchor("termsOfService", "content")}>
          <TextareaField
            controllerProps={{ name: "content" }}
            formFieldProps={fields.content}
            textareaProps={{ readOnly, rows: 10 }}
            maxLength={CONFIG_BOUNDS.MAX_TERMS_OF_SERVICE_LENGTH}
          />
        </SettingAnchor>
      </Container>
    </SpaceBetween>
  );
}
export function TermsOfServiceForm() {
  return (
    <SectionForm
      section="termsOfService"
      renderFields={(readOnly) => (
        <TermsOfServiceFormFields readOnly={readOnly} />
      )}
    />
  );
}
