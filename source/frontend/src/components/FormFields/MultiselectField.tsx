// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { FormField, Multiselect } from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { MultiselectProps } from "@cloudscape-design/components/multiselect";
import {
  type FieldPath,
  type FieldPathValue,
  type FieldValues,
  useController,
  type UseControllerProps,
} from "react-hook-form";

export interface MultiselectFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration. */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.). */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** Multiselect component props and value conversion handlers. */
  multiselectProps: Omit<MultiselectProps, "selectedOptions"> & {
    /** Converts the stored form value to selected Multiselect options. */
    valueToOptions: (
      value: FieldPathValue<TFieldValues, TName>,
    ) => ReadonlyArray<MultiselectProps.Option>;
    /** Converts selected Multiselect options to the stored form value. */
    optionsToValue: (
      options: ReadonlyArray<MultiselectProps.Option>,
    ) => FieldPathValue<TFieldValues, TName>;
    /** Return false to reject a converted value before updating form state. */
    shouldUpdateValue?: (value: FieldPathValue<TFieldValues, TName>) => boolean;
  };
}

export default function MultiselectField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  multiselectProps,
}: Readonly<MultiselectFieldProps<TFieldValues, TName>>) {
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
    valueToOptions,
    optionsToValue,
    shouldUpdateValue,
    onChange: customOnChange,
    onBlur: customOnBlur,
    ...restMultiselectProps
  } = multiselectProps;

  return (
    <FormField {...formFieldProps} errorText={fieldError?.message}>
      <Multiselect
        {...restMultiselectProps}
        ref={fieldRef}
        selectedOptions={valueToOptions(fieldValue)}
        onChange={(event) => {
          const newValue = optionsToValue(event.detail.selectedOptions);
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
