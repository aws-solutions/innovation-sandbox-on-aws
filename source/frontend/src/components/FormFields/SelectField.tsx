// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { FormField, Select } from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { SelectProps } from "@cloudscape-design/components/select";
import {
  type FieldPath,
  type FieldPathValue,
  type FieldValues,
  useController,
  type UseControllerProps,
} from "react-hook-form";

export interface SelectFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** Select component props and event handlers */
  selectProps: Omit<SelectProps, "selectedOption"> & {
    /** Function to convert form value to SelectProps.Option */
    valueToOption: (
      value: FieldPathValue<TFieldValues, TName>,
    ) => SelectProps.Option | null;
    /** Function to convert SelectProps.Option to form value */
    optionToValue: (
      option: SelectProps.Option | null,
    ) => FieldPathValue<TFieldValues, TName>;
    /** Return false to reject a converted value before updating form state. */
    shouldUpdateValue?: (value: FieldPathValue<TFieldValues, TName>) => boolean;
  };
}

export default function SelectField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  selectProps,
}: Readonly<SelectFieldProps<TFieldValues, TName>>) {
  const {
    field: {
      onBlur: onFieldBlur,
      onChange: onFieldChange,
      ref: fieldRef,
      value: fieldValue,
    },
    fieldState: { error: fieldError },
  } = useController(controllerProps);

  const {
    valueToOption,
    optionToValue,
    shouldUpdateValue,
    onChange: customOnChange,
    onBlur: customOnBlur,
    ...restSelectProps
  } = selectProps;

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      <Select
        {...restSelectProps}
        ref={fieldRef}
        selectedOption={valueToOption(fieldValue)}
        onChange={(event) => {
          const newValue = optionToValue(event.detail.selectedOption);
          if (shouldUpdateValue?.(newValue) ?? true) {
            onFieldChange(newValue);
          }
          customOnChange?.(event);
        }}
        onBlur={(event) => {
          onFieldBlur();
          customOnBlur?.(event);
        }}
      />
    </FormField>
  );
}
