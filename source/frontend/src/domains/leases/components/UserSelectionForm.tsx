// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Container, SpaceBetween } from "@cloudscape-design/components";
import { useFormContext } from "react-hook-form";

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";

export const UserSelectionForm = () => {
  const { control } = useFormContext();

  return (
    <Container>
      <SpaceBetween direction="vertical" size="l">
        <InputField
          controllerProps={{
            control,
            name: "userEmail",
          }}
          formFieldProps={{
            label: "User email",
            description:
              "Enter the email address of the user you want to assign this lease to",
          }}
          inputProps={{
            placeholder: "user@example.com",
            type: "email",
          }}
        />
      </SpaceBetween>
    </Container>
  );
};
