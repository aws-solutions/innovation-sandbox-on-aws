// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SpaceBetween } from "@cloudscape-design/components";
import { useFormContext, useWatch } from "react-hook-form";

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import TextareaField from "@amzn/innovation-sandbox-frontend/components/FormFields/TextareaField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import type { Visibility } from "@amzn/innovation-sandbox-shared/types/lease-template.js";

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

  const visibility = useWatch({ control, name: "visibility" });
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
        controllerProps={{ control, name: "visibility" }}
        formFieldProps={{
          label: "Allow user requests",
          description:
            "When enabled, users can see this template and request leases from it. When disabled, only managers and administrators can assign or request leases from it.",
        }}
        toggleProps={{
          children:
            visibility === "PUBLIC" ? "Requests allowed" : "Assignment only",
        }}
        valueToChecked={(value) => value === "PUBLIC"}
        checkedToValue={(checked) => (checked ? "PUBLIC" : "PRIVATE")}
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
    </SpaceBetween>
  );
}
