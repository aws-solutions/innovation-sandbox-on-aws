// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Container,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useFormContext } from "react-hook-form";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import CheckboxField from "@amzn/innovation-sandbox-frontend/components/FormFields/CheckboxField";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";

interface TermsOfServiceStepProps {
  checkboxText?: string;
}

export const TermsOfServiceForm = ({
  checkboxText = "I accept the above terms of service.",
}: TermsOfServiceStepProps) => {
  const { control } = useFormContext();

  const {
    data: config,
    isLoading,
    isError,
    refetch,
    error,
  } = useGetConfigurations();

  if (isLoading) {
    return (
      <Container>
        <Loader label="Loading terms of service..." />
      </Container>
    );
  }

  if (isError) {
    return (
      <Container>
        <ErrorPanel
          description="Could not retrieve terms of service."
          retry={refetch}
          error={error as Error}
        />
      </Container>
    );
  }

  return (
    <Container>
      <SpaceBetween direction="vertical" size="l">
        <SpaceBetween size="s">
          <Box variant="strong">
            Before continuing, please review the terms of service below.
          </Box>
          <Container>
            {config?.termsOfService ? (
              <Box
                variant="pre"
                nativeAttributes={{ style: { textWrap: "auto" } }}
              >
                {config.termsOfService}
              </Box>
            ) : (
              <Alert
                type="warning"
                header="Terms of Service have not been configured yet."
              >
                Please contact your administrator!
              </Alert>
            )}
          </Container>
        </SpaceBetween>
        <CheckboxField
          controllerProps={{
            control,
            name: "acceptTerms",
          }}
          checkboxProps={{
            children: checkboxText,
          }}
        />
      </SpaceBetween>
    </Container>
  );
};
