// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Button,
  FormField,
  Link,
  List,
  Select,
  SpaceBetween,
} from "@cloudscape-design/components";

import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";

interface RegionListBuilderProps {
  selectedRegions: string[];
  onChange: (regions: string[]) => void;
  errorText?: string;
  disabled?: boolean;
}

/**
 * Region list builder using Cloudscape List with drag-and-drop reordering.
 * Matches AWS Console StackSet deployment region selection pattern.
 * Uses simple string array for region codes (e.g., ["us-east-1", "us-west-2"]).
 */
export const RegionListBuilder = ({
  selectedRegions,
  onChange,
  errorText,
  disabled = false,
}: RegionListBuilderProps) => {
  const {
    data: config,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetConfigurations();

  const isbManagedRegions = [...new Set(config?.isbManagedRegions || [])];
  const availableRegions = isbManagedRegions.filter(
    (region) => !selectedRegions.includes(region),
  );

  const getPlaceholderText = () => {
    if (isLoading) return "Loading ISB managed regions...";
    if (availableRegions.length === 0) {
      return selectedRegions.length > 0
        ? "All regions selected"
        : "No ISB managed regions configured";
    }
    return "Select region";
  };

  if (isError) {
    return (
      <Alert
        type="error"
        header="Failed to load ISB managed regions"
        action={<Link onFollow={() => refetch()}>Retry</Link>}
      >
        {error instanceof Error
          ? error.message
          : "Unable to load configuration. Please try again."}
      </Alert>
    );
  }

  return (
    <FormField
      label="Deployment Regions"
      description="Select regions for deployment. Drag to reorder. Deployment follows this order."
      errorText={errorText}
    >
      <SpaceBetween size="s">
        {selectedRegions.length > 0 && (
          <List
            sortable
            sortDisabled={disabled}
            items={selectedRegions}
            renderItem={(region) => ({
              id: region,
              content: region,
              actions: (
                <Button
                  onClick={() =>
                    onChange(selectedRegions.filter((r) => r !== region))
                  }
                  disabled={disabled}
                  variant="icon"
                  iconName="close"
                  ariaLabel={`Delete ${region}`}
                />
              ),
            })}
            onSortingChange={({ detail }) => onChange([...detail.items])}
          />
        )}

        <Select
          selectedOption={null}
          onChange={({ detail }) => {
            if (detail.selectedOption?.value) {
              onChange([...selectedRegions, detail.selectedOption.value]);
            }
          }}
          options={availableRegions.map((region) => ({
            value: region,
            label: region,
          }))}
          placeholder={getPlaceholderText()}
          loadingText="Loading ISB managed regions..."
          statusType={isLoading ? "loading" : "finished"}
          empty="No ISB managed regions configured"
          filteringType="auto"
          disabled={disabled || isLoading || availableRegions.length === 0}
          invalid={!!errorText}
        />

        <SpaceBetween direction="horizontal" size="xs">
          <Button
            onClick={() => onChange(isbManagedRegions)}
            disabled={
              disabled ||
              isLoading ||
              isbManagedRegions.length === 0 ||
              selectedRegions.length === isbManagedRegions.length
            }
          >
            Add all regions
          </Button>
          <Button
            onClick={() => onChange([])}
            disabled={disabled || isLoading || selectedRegions.length === 0}
          >
            Remove all regions
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </FormField>
  );
};
