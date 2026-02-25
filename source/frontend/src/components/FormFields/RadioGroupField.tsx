// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { FormField, RadioGroup } from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { RadioGroupProps } from "@cloudscape-design/components/radio-group";
import {
  useController,
  UseControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

export interface RadioGroupFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** RadioGroup component props and event handlers */
  radioGroupProps?: Omit<RadioGroupProps, "value">;
}

export default function RadioGroupField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  radioGroupProps,
}: RadioGroupFieldProps<TFieldValues, TName>) {
  const {
    field: {
      onChange: onFieldChange,
      name: fieldName,
      ref: fieldRef,
      value: fieldValue,
    },
    fieldState: { error: fieldError },
  } = useController(controllerProps);

  const { onChange: customOnChange, ...restRadioGroupProps } =
    radioGroupProps || {};

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      <RadioGroup
        {...restRadioGroupProps}
        name={fieldName}
        ref={fieldRef}
        value={fieldValue}
        onChange={(event) => {
          onFieldChange(event.detail.value);
          customOnChange?.(event);
        }}
      />
    </FormField>
  );
}
