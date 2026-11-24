// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Select, type SelectProps } from "@cloudscape-design/components";

export type ModelOption = {
  modelId: string;
  displayName: string;
  /** Groups the option under a provider heading in the picker; ungrouped when absent. */
  provider?: string;
};

export type ModelSelectorProps = {
  models: ModelOption[];
  selectedModelId: string | undefined;
  onSelectModel: (modelId: string) => void;
  /** Locked mid-turn: a turn is priced at the model it was sent with. */
  disabled?: boolean;
};

/**
 * Builds the picker's option list, grouping models by provider while preserving
 * first-seen order for both providers and the models within each provider.
 * Models without a provider stay as top-level options, appended after the
 * grouped providers.
 */
const buildOptions = (models: ModelOption[]): SelectProps.Options => {
  const groupsByProvider = new Map<string, SelectProps.Option[]>();
  const ungrouped: SelectProps.Option[] = [];

  for (const model of models) {
    const option: SelectProps.Option = {
      value: model.modelId,
      label: model.displayName,
    };
    if (model.provider === undefined) {
      ungrouped.push(option);
      continue;
    }
    const existing = groupsByProvider.get(model.provider);
    if (existing) {
      existing.push(option);
    } else {
      groupsByProvider.set(model.provider, [option]);
    }
  }

  const groups: SelectProps.Options = Array.from(
    groupsByProvider,
    ([provider, options]) => ({ label: provider, options }),
  );

  return [...groups, ...ungrouped];
};

export const ModelSelector = ({
  models,
  selectedModelId,
  onSelectModel,
  disabled = false,
}: ModelSelectorProps) => {
  const selectedModel = models.find(
    (model) => model.modelId === selectedModelId,
  );
  const selectedOption: SelectProps.Option | null = selectedModel
    ? { value: selectedModel.modelId, label: selectedModel.displayName }
    : null;

  return (
    <Select
      ariaLabel="Select model"
      options={buildOptions(models)}
      selectedOption={selectedOption}
      disabled={disabled}
      placeholder="Select a model"
      // Lets the list open upward from the composer instead of being clipped.
      expandToViewport
      filteringType="auto"
      filteringAriaLabel="Filter models"
      filteringPlaceholder="Search models"
      selectedAriaLabel="Selected"
      onChange={({ detail }) => {
        const value = detail.selectedOption.value;
        if (value) {
          onSelectModel(value);
        }
      }}
    />
  );
};
