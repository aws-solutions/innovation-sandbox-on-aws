// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Container, Header, SpaceBetween } from "@cloudscape-design/components";
import { useFormContext } from "react-hook-form";

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import TagEditorField from "@amzn/innovation-sandbox-frontend/components/FormFields/TagEditorField";
import {
  BLUEPRINT_NAME_CONSTRAINTS,
  BLUEPRINT_TAG_CONSTRAINTS,
  BlueprintWizardFormValues,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";

export function BasicDetailsForm() {
  const { control } = useFormContext<BlueprintWizardFormValues>();

  return (
    <Container header={<Header variant="h2">Blueprint Details</Header>}>
      <SpaceBetween size="l">
        <InputField
          controllerProps={{ control, name: "name" }}
          formFieldProps={{
            label: "Blueprint Name",
            description:
              "A descriptive name to help users identify when to use this blueprint",
            constraintText: BLUEPRINT_NAME_CONSTRAINTS.CONSTRAINT_TEXT,
          }}
          inputProps={{
            placeholder: "Enter blueprint name",
          }}
        />

        <TagEditorField
          controllerProps={{ control, name: "tags" }}
          formFieldProps={{
            label: "Tags (optional)",
            description: "Add tags to organize and categorize your blueprints",
            constraintText: `Keys: ${BLUEPRINT_TAG_CONSTRAINTS.KEY_CONSTRAINT_TEXT}. Values: ${BLUEPRINT_TAG_CONSTRAINTS.VALUE_CONSTRAINT_TEXT}`,
          }}
          maxTags={BLUEPRINT_TAG_CONSTRAINTS.MAX_TAGS}
          keyPlaceholder="e.g., Environment, Cost-Center, Project"
          valuePlaceholder="e.g., Production, Finance/IT (optional)"
        />
      </SpaceBetween>
    </Container>
  );
}
