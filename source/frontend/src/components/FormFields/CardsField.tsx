// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Cards,
  CardsProps,
  FormField,
  FormFieldProps,
} from "@cloudscape-design/components";
import {
  FieldPath,
  FieldValues,
  useController,
  UseControllerProps,
} from "react-hook-form";

export interface CardsFieldProps<
  T,
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** Cards component props */
  cardsProps: Omit<CardsProps<T>, "selectedItems" | "selectionType"> & {
    selectionType?: "single" | "multi";
  };
  /**
   * Optional function to extract a specific value from the selected item.
   * Useful for storing just an ID instead of the entire object.
   * Only applies to single selection mode.
   */
  valueExtractor?: (item: T) => any;
  /**
   * Optional function to match an item with the stored value.
   * Required when using valueExtractor to find the selected item from the stored value.
   * Only applies to single selection mode.
   */
  itemMatcher?: (item: T, value: any) => boolean;
}

/**
 * CardsField component that integrates CloudScape Cards with React Hook Form.
 * Supports both single and multi-selection modes.
 *
 * For single selection mode, you can optionally provide a `valueExtractor` function
 * to extract a specific property from the selected item (e.g., extracting an ID).
 */
export default function CardsField<
  T,
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  cardsProps,
  valueExtractor,
  itemMatcher,
}: CardsFieldProps<T, TFieldValues, TName>) {
  const {
    field: { onChange: onFieldChange, value: fieldValue, ref: fieldRef },
    fieldState: { error: fieldError },
  } = useController(controllerProps);

  const {
    selectionType = "single",
    items = [],
    onSelectionChange: customOnSelectionChange,
    ...restCardsProps
  } = cardsProps;

  const handleSelectionChange = (event: any) => {
    if (selectionType === "single") {
      // For single selection, extract value if extractor provided
      const selectedItem = event.detail.selectedItems[0];
      if (valueExtractor && selectedItem) {
        onFieldChange(valueExtractor(selectedItem));
      } else {
        onFieldChange(selectedItem || "");
      }
    } else {
      // For multi selection, store the array of selected items
      onFieldChange(event.detail.selectedItems);
    }

    // Call custom handler if provided
    customOnSelectionChange?.(event);
  };

  // Convert field value to selectedItems array
  const selectedItems = (() => {
    if (selectionType === "single") {
      if (!fieldValue) return [];

      // If we have a value extractor and item matcher, find the matching item
      if (valueExtractor && itemMatcher) {
        const matchedItem = items.find((item) => itemMatcher(item, fieldValue));
        return matchedItem ? [matchedItem] : [];
      }

      // Otherwise, assume fieldValue is the item itself
      return [fieldValue];
    } else {
      // For multi selection, fieldValue should already be an array
      return Array.isArray(fieldValue) ? fieldValue : [];
    }
  })();

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      <Cards
        {...restCardsProps}
        items={items}
        selectedItems={selectedItems}
        ref={fieldRef}
        onSelectionChange={handleSelectionChange}
        selectionType={selectionType}
      />
    </FormField>
  );
}
