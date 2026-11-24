// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Container, Header, SpaceBetween } from "@cloudscape-design/components";

import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import { BedrockInferenceProfileNotice } from "@amzn/innovation-sandbox-frontend/domains/settings/components/BedrockInferenceProfileNotice";
import {
  type FormFieldDefinitions,
  formSearchFields,
  settingAnchor,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";

import { BEDROCK_TOKEN_MONITORING_HREF } from "./LeasesForm";
import { SectionForm } from "./SectionForm";
import { SettingAnchor } from "./SettingAnchor";

const description = {
  prefix:
    "Lets lease templates offer a Sandbox Space to users with an active lease. When off, templates can't enable a Space and Spaces on active leases become unavailable until it's turned back on. Conversations and the enabled model list are kept. Amazon Bedrock token monitoring is turned on for every lease with a Sandbox Space, even when ",
  linkText: "Allow Bedrock token monitoring",
  suffix: " is off.",
};

const fields = {
  sandboxSpacesEnabled: {
    label: "Enable Sandbox Spaces",
    description: `${description.prefix}${description.linkText}${description.suffix}`,
  },
} satisfies FormFieldDefinitions<"agent">;

export const agentConfigFormSearchFields = formSearchFields({
  section: "agent",
  group: "sandbox-spaces",
  subgroup: "Availability",
  fields,
});
const SPACE_DESCRIPTION = (
  <>
    {description.prefix}
    <TextLink
      to={BEDROCK_TOKEN_MONITORING_HREF}
      variant="primary"
      fontSize="inherit"
    >
      {description.linkText}
    </TextLink>
    {description.suffix}
  </>
);

function AgentConfigFormFields({
  readOnly,
  bedrockInferenceProfilePatterns,
}: Readonly<{
  readOnly: boolean;
  bedrockInferenceProfilePatterns: string[];
}>) {
  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description={
              "Managers turn Spaces on per lease template; this switch controls whether that option exists at all."
            }
          >
            Availability
          </Header>
        }
      >
        <SpaceBetween size="m">
          <BedrockInferenceProfileNotice
            bedrockInferenceProfilePatterns={bedrockInferenceProfilePatterns}
          />
          <SettingAnchor id={settingAnchor("agent", "sandboxSpacesEnabled")}>
            <ToggleField
              toggleProps={{ readOnly }}
              controllerProps={{ name: "sandboxSpacesEnabled" }}
              formFieldProps={{
                ...fields.sandboxSpacesEnabled,
                stretch: true,
                description: SPACE_DESCRIPTION,
              }}
              stateLabel
            />
          </SettingAnchor>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
export function AgentConfigForm({
  bedrockInferenceProfilePatterns,
}: Readonly<{
  bedrockInferenceProfilePatterns: string[];
}>) {
  return (
    <SectionForm
      section="agent"
      renderFields={(readOnly) => (
        <AgentConfigFormFields
          readOnly={readOnly}
          bedrockInferenceProfilePatterns={bedrockInferenceProfilePatterns}
        />
      )}
    />
  );
}
