// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { FormField, Input } from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { InputProps } from "@cloudscape-design/components/input";
import {
  useController,
  UseControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

export interface InputFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** Input component props and event handlers */
  inputProps?: Omit<InputProps, "value">;
}

export default function InputField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  inputProps,
}: InputFieldProps<TFieldValues, TName>) {
  const {
    field: {
      onBlur: onFieldBlur,
      onChange: onFieldChange,
      name: fieldName,
      ref: fieldRef,
      value: fieldValue,
    },
    fieldState: { error: fieldError },
  } = useController(controllerProps);

  const {
    onChange: customOnChange,
    onBlur: customOnBlur,
    type,
    ...restInputProps
  } = inputProps || {};

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      <Input
        {...restInputProps}
        name={fieldName}
        type={type}
        value={fieldValue}
        ref={fieldRef}
        onChange={(event) => {
          const value = event.detail.value;
          if (type === "number") {
            const numValue = parseFloat(value);
            onFieldChange(isNaN(numValue) ? "" : numValue);
          } else {
            // Empty text inputs become undefined
            onFieldChange(value);
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
