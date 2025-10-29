// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Container,
  FormField,
  Input,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useEffect, useState } from "react";
import { z } from "zod";

interface UserSelectionStepProps {
  value: string;
  onChange: (email: string) => void;
  onValidationChange?: (isValid: boolean) => void;
  showValidationErrors?: boolean;
}

export const UserSelectionStep = ({
  value,
  onChange,
  onValidationChange,
  showValidationErrors = false,
}: UserSelectionStepProps) => {
  const [hasBeenTouched, setHasBeenTouched] = useState(false);

  // Email format validation
  const validateEmail = (
    email: string,
  ): { isValid: boolean; errorMessage?: string } => {
    if (!email) {
      return { isValid: false, errorMessage: "Please provide a user email" };
    }

    if (!z.string().email().safeParse(email).success) {
      return {
        isValid: false,
        errorMessage: "Please enter a valid email address",
      };
    }

    return { isValid: true };
  };

  // Validate whenever value changes and notify parent
  useEffect(() => {
    const validation = validateEmail(value);
    onValidationChange?.(validation.isValid);
  }, [value, onValidationChange]);

  const validation = validateEmail(value);
  // Show error when field has been touched, validation fails, or parent requests to show errors
  const showError =
    (hasBeenTouched || showValidationErrors) && !validation.isValid;

  const handleInputChange = (newValue: string) => {
    if (!hasBeenTouched) {
      setHasBeenTouched(true);
    }
    onChange(newValue);
  };

  return (
    <Container>
      <SpaceBetween direction="vertical" size="l">
        <FormField
          label="User email"
          description="Enter the email address of the user you want to assign this lease to"
          errorText={showError ? validation.errorMessage : undefined}
        >
          <Input
            value={value}
            onChange={({ detail }) => handleInputChange(detail.value)}
            placeholder="user@example.com"
            type="email"
            invalid={showError}
          />
        </FormField>
      </SpaceBetween>
    </Container>
  );
};
