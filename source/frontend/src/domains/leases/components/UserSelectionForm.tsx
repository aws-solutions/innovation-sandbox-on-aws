// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Container,
  FormField,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useFormContext, useWatch } from "react-hook-form";

import { PrincipalTypeahead } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead";
import type { IdcPrincipalView } from "@amzn/innovation-sandbox-frontend/domains/principals/model";

type UserSelectionFormShape = {
  selectedUser?: {
    principalId: string;
    email: string;
    displayName?: string;
  };
  assignments?: unknown[];
};

export type UserSelectionFormProps = {
  enablePrincipalSearch?: boolean;
  clearAssignmentsOnChange?: boolean;
};

export const UserSelectionForm = ({
  enablePrincipalSearch = true,
  clearAssignmentsOnChange = false,
}: UserSelectionFormProps = {}) => {
  const {
    formState: { errors },
    control,
    getValues,
    setValue,
  } = useFormContext<UserSelectionFormShape>();

  const selectedUser = useWatch({ control, name: "selectedUser" });

  const selectUser = (principal: IdcPrincipalView) => {
    if (!principal.email) return;

    const currentUser = getValues("selectedUser");
    const assignments = getValues("assignments");
    if (
      clearAssignmentsOnChange &&
      principal.principalId !== currentUser?.principalId &&
      assignments?.length
    ) {
      setValue("assignments", undefined, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
    setValue(
      "selectedUser",
      {
        principalId: principal.principalId,
        email: principal.email,
        displayName: principal.displayName,
      },
      {
        shouldValidate: true,
        shouldDirty: true,
      },
    );
  };

  return (
    <Container>
      <SpaceBetween direction="vertical" size="m">
        <FormField
          label="User"
          description="Search by name or email, or type an email and click Add to resolve."
          errorText={errors.selectedUser?.message}
        >
          <PrincipalTypeahead
            type="users"
            placeholder="Search or enter user email"
            ariaLabel="Search users"
            enablePrincipalSearch={enablePrincipalSearch}
            onSelect={selectUser}
          />
        </FormField>
        {selectedUser?.displayName && (
          <Box variant="small">
            Selected: <strong>{selectedUser.displayName}</strong>
            {` (${selectedUser.email})`}
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
};
