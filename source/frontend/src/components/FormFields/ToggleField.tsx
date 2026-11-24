// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { FormField, SpaceBetween, Toggle } from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { ToggleProps } from "@cloudscape-design/components/toggle";
import type { ReactNode } from "react";
import {
  type FieldPath,
  type FieldValues,
  useController,
  UseControllerProps,
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
  /**
   * When true, renders a live "Enabled"/"Disabled" label beside the toggle,
   * derived from the current value — matching the app convention of showing a
   * toggle's state inline. Ignored if an explicit `toggleProps.children` is
   * given (that takes precedence).
   */
  stateLabel?: boolean;
  /** Maps a non-boolean form value to the toggle state. Defaults to `Boolean(value)`. */
  valueToChecked?: (value: TFieldValues[TName]) => boolean;
  /** Maps the toggle state back to the form value. Defaults to the boolean itself. */
  checkedToValue?: (checked: boolean) => TFieldValues[TName];
  toggleSuffix?: ReactNode;
}

export default function ToggleField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  toggleProps,
  stateLabel,
  valueToChecked = Boolean,
  checkedToValue = (checked) => checked as TFieldValues[TName],
  toggleSuffix,
}: Readonly<ToggleFieldProps<TFieldValues, TName>>) {
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

  // An explicit `children` always wins; otherwise `stateLabel` renders a live
  // "Enabled"/"Disabled" label from the current value.
  const checked = valueToChecked(fieldValue);
  const stateText = checked ? "Enabled" : "Disabled";
  const label = children ?? (stateLabel ? stateText : undefined);

  const toggle = (
    <Toggle
      {...restToggleProps}
      name={fieldName}
      checked={checked}
      ref={fieldRef}
      onChange={(event) => {
        onFieldChange(checkedToValue(event.detail.checked));
        customOnChange?.(event);
      }}
      onBlur={(event) => {
        onFieldBlur();
        customOnBlur?.(event);
      }}
    >
      {label}
    </Toggle>
  );

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      {toggleSuffix ? (
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          {toggle}
          {toggleSuffix}
        </SpaceBetween>
      ) : (
        toggle
      )}
    </FormField>
  );
}
