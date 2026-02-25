// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Checkbox,
  CheckboxProps,
  FormField,
  FormFieldProps,
} from "@cloudscape-design/components";
import {
  FieldPath,
  FieldValues,
  useController,
  UseControllerProps,
} from "react-hook-form";

export interface CheckboxFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** Checkbox component props */
  checkboxProps?: Omit<CheckboxProps, "checked">;
}

/**
 * CheckboxField component that integrates CloudScape Checkbox with React Hook Form.
 */
export default function CheckboxField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  checkboxProps,
}: CheckboxFieldProps<TFieldValues, TName>) {
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

  const { onChange: customOnChange, ...restCheckboxProps } =
    checkboxProps || {};

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      <Checkbox
        {...restCheckboxProps}
        name={fieldName}
        checked={fieldValue}
        ref={fieldRef}
        onChange={(event) => {
          onFieldChange(event.detail.checked);
          customOnChange?.(event);
        }}
        onBlur={onFieldBlur}
      />
    </FormField>
  );
}
