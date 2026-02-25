// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { FormField, Slider } from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { SliderProps } from "@cloudscape-design/components/slider";
import {
  useController,
  UseControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";

export interface SliderFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** Slider component props and event handlers */
  sliderProps: Omit<SliderProps, "value">;
}

export default function SliderField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  sliderProps,
}: SliderFieldProps<TFieldValues, TName>) {
  const {
    field: { onChange: onFieldChange, value: fieldValue },
    fieldState: { error: fieldError },
  } = useController(controllerProps);

  const { onChange: customOnChange, ...restSliderProps } = sliderProps;

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      <Slider
        {...restSliderProps}
        value={fieldValue}
        onChange={(event) => {
          onFieldChange(event.detail.value);
          customOnChange?.(event);
        }}
      />
    </FormField>
  );
}
