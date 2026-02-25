// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SpaceBetween } from "@cloudscape-design/components";
import type { SelectProps } from "@cloudscape-design/components/select";
import { useFormContext, useWatch } from "react-hook-form";

import { Visibility } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import SelectField from "@amzn/innovation-sandbox-frontend/components/FormFields/SelectField";
import TextareaField from "@amzn/innovation-sandbox-frontend/components/FormFields/TextareaField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";

export interface VisibilityOption {
  label: string;
  value: Visibility;
}

const VISIBILITY_OPTIONS: readonly VisibilityOption[] = [
  { label: "Private", value: "PRIVATE" },
  { label: "Public", value: "PUBLIC" },
];

function getVisibilityOption(
  visibility: Visibility,
): SelectProps.Option | null {
  return VISIBILITY_OPTIONS.find((opt) => opt.value === visibility) || null;
}

function getVisibilityValue(option: SelectProps.Option | null): Visibility {
  return (option?.value as Visibility) || "PRIVATE";
}

export interface BasicDetailsFormValues {
  name: string;
  description?: string;
  requiresApproval: boolean;
  visibility: Visibility;
}

/**
 * Form component for lease template basic details.
 * Uses FormContext from parent - no internal state management.
 */
export function BasicDetailsForm() {
  // Get control from form context
  const { control } = useFormContext<BasicDetailsFormValues>();

  // Watch requiresApproval for dynamic toggle label
  const requiresApproval = useWatch({ control, name: "requiresApproval" });

  return (
    <SpaceBetween size="l">
      <InputField
        controllerProps={{ control, name: "name" }}
        formFieldProps={{
          label: "Name",
          description:
            "A descriptive name to help users identify when to use this template",
        }}
        inputProps={{
          placeholder: "Enter template name",
        }}
      />

      <TextareaField
        controllerProps={{ control, name: "description" }}
        formFieldProps={{
          label: (
            <>
              Description - <i>Optional</i>
            </>
          ),
          description: "A brief description of this lease template",
        }}
        textareaProps={{
          placeholder: "Enter template description",
          rows: 4,
        }}
      />

      <ToggleField
        controllerProps={{ control, name: "requiresApproval" }}
        formFieldProps={{
          label: "Requires Approval",
          description:
            "When enabled, lease requests using this template must be approved by a manager before the sandbox is provisioned",
        }}
        toggleProps={{
          children: requiresApproval ? "Approval required" : "Auto-approved",
        }}
      />

      <SelectField
        controllerProps={{ control, name: "visibility" }}
        formFieldProps={{
          label: "Visibility",
          description:
            "Controls if users can view and request leases using this template",
        }}
        selectProps={{
          options: VISIBILITY_OPTIONS,
          placeholder: "Select visibility",
          valueToOption: getVisibilityOption,
          optionToValue: getVisibilityValue,
        }}
      />
    </SpaceBetween>
  );
}
