// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { TermsOfService } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TermsOfService";
import {
  Box,
  Checkbox,
  Container,
  FormField,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useEffect } from "react";

interface TermsOfServiceStepProps {
  acceptTerms: boolean;
  onAcceptTermsChange: (accepted: boolean) => void;
  onValidationChange?: (isValid: boolean) => void;
  showValidationErrors?: boolean;
  checkboxText?: string;
}

export const TermsOfServiceStep = ({
  acceptTerms,
  onAcceptTermsChange,
  onValidationChange,
  showValidationErrors = false,
  checkboxText = "I accept the above terms of service.",
}: TermsOfServiceStepProps) => {
  // Terms validation
  const validateTerms = (
    accepted: boolean,
  ): { isValid: boolean; errorMessage?: string } => {
    if (!accepted) {
      return {
        isValid: false,
        errorMessage: "Please accept the terms of service to continue",
      };
    }
    return { isValid: true };
  };

  // Validate whenever acceptTerms changes and notify parent
  useEffect(() => {
    const validation = validateTerms(acceptTerms);
    onValidationChange?.(validation.isValid);
  }, [acceptTerms, onValidationChange]);

  const validation = validateTerms(acceptTerms);
  const showError = showValidationErrors && !validation.isValid;

  return (
    <Container>
      <SpaceBetween direction="vertical" size="l">
        <Box>
          <TermsOfService />
        </Box>
        <FormField errorText={showError ? validation.errorMessage : undefined}>
          <Checkbox
            checked={acceptTerms}
            onChange={({ detail }) => onAcceptTermsChange(detail.checked)}
          >
            {checkboxText}
          </Checkbox>
        </FormField>
      </SpaceBetween>
    </Container>
  );
};
