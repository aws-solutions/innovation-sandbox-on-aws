// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { FormField, Input } from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { InputProps } from "@cloudscape-design/components/input";
import {
  type FieldPath,
  type FieldValues,
  useController,
  UseControllerProps,
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
  /**
   * Numeric bounds (only meaningful for `type="number"`). When set, `min`/`max`
   * are forwarded to the native input element via Cloudscape's
   * `nativeInputAttributes` (Cloudscape's Input does not expose them directly),
   * which bounds the stepper arrows and native validation. A value TYPED outside
   * the range is caught by the field's zod resolver (live under `mode: "all"`),
   * which shows an inline error and disables Save — so an out-of-range value is
   * surfaced rather than silently rewritten. The zod schema on Save remains the
   * source of truth.
   */
  min?: number;
  max?: number;
}

export default function InputField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  inputProps,
  min,
  max,
}: Readonly<InputFieldProps<TFieldValues, TName>>) {
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
    nativeInputAttributes,
    ...restInputProps
  } = inputProps || {};

  // Forward numeric bounds to the native <input> via Cloudscape's
  // `nativeInputAttributes` (the Input component does not expose min/max). This
  // bounds the stepper arrows + native validation. A typed out-of-range value is
  // caught by the zod resolver (inline error + Save disabled), not silently
  // rewritten. Caller-supplied nativeInputAttributes win on conflict.
  const boundsAttributes =
    type === "number" && (min !== undefined || max !== undefined)
      ? {
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
          ...nativeInputAttributes,
        }
      : nativeInputAttributes;

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      <Input
        {...restInputProps}
        name={fieldName}
        type={type}
        nativeInputAttributes={boundsAttributes}
        value={fieldValue}
        ref={fieldRef}
        onChange={(event) => {
          const value = event.detail.value;
          if (type === "number") {
            const numValue = Number.parseFloat(value);
            onFieldChange(Number.isNaN(numValue) ? "" : numValue);
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
