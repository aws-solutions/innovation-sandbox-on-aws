// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Select, type SelectProps } from "@cloudscape-design/components";

type AssignmentPermissionSetSelectorProps = {
  principalDisplayName: string;
  selectedOption: SelectProps.Option | null;
  options: readonly SelectProps.Option[];
  disabled?: boolean;
  onChange: (permissionSetArn: string) => void;
};

export const AssignmentPermissionSetSelector = ({
  principalDisplayName,
  selectedOption,
  options,
  disabled = false,
  onChange,
}: AssignmentPermissionSetSelectorProps) => (
  <Select
    ariaLabel={`Permission set for ${principalDisplayName}`}
    selectedOption={selectedOption}
    options={options}
    onChange={({ detail }) => {
      if (detail.selectedOption.value) {
        onChange(detail.selectedOption.value);
      }
    }}
    placeholder="Choose permission set"
    disabled={disabled}
    expandToViewport
  />
);
