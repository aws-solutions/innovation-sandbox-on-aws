// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { FormField, Toggle } from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { ToggleProps } from "@cloudscape-design/components/toggle";
import {
  useController,
  UseControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

export interface ToggleFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** Toggle component props and event handlers */
  toggleProps?: Omit<ToggleProps, "checked">;
}

export default function ToggleField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  toggleProps,
}: ToggleFieldProps<TFieldValues, TName>) {
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
    children,
    ...restToggleProps
  } = toggleProps || {};

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      <Toggle
        {...restToggleProps}
        name={fieldName}
        checked={fieldValue}
        ref={fieldRef}
        onChange={(event) => {
          onFieldChange(event.detail.checked);
          customOnChange?.(event);
        }}
        onBlur={(event) => {
          onFieldBlur();
          customOnBlur?.(event);
        }}
      >
        {children}
      </Toggle>
    </FormField>
  );
}
