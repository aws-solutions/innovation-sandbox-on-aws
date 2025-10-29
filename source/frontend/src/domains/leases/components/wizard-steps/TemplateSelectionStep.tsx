// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SelectLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leases/components/SelectLeaseTemplate";
import {
  Container,
  FormField,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useEffect } from "react";

interface TemplateSelectionStepProps {
  value: string;
  onChange: (templateId: string) => void;
  onValidationChange?: (isValid: boolean) => void;
  showValidationErrors?: boolean;
  label?: string;
}

export const TemplateSelectionStep = ({
  value,
  onChange,
  onValidationChange,
  showValidationErrors = false,
  label = "What lease template would you like to use?",
}: TemplateSelectionStepProps) => {
  // Template validation
  const validateTemplate = (
    templateId: string,
  ): { isValid: boolean; errorMessage?: string } => {
    if (!templateId) {
      return {
        isValid: false,
        errorMessage: "Please select a lease template to continue",
      };
    }
    return { isValid: true };
  };

  // Validate whenever value changes and notify parent
  useEffect(() => {
    const validation = validateTemplate(value);
    onValidationChange?.(validation.isValid);
  }, [value, onValidationChange]);

  const validation = validateTemplate(value);
  const showError = showValidationErrors && !validation.isValid;

  return (
    <Container>
      <SpaceBetween direction="vertical" size="l">
        <FormField
          stretch
          label={label}
          errorText={showError ? validation.errorMessage : undefined}
        >
          <SelectLeaseTemplate value={value} onChange={onChange} />
        </FormField>
      </SpaceBetween>
    </Container>
  );
};
