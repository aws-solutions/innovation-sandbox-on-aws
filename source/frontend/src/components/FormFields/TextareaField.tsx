// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  FormField,
  LiveRegion,
  Textarea,
} from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { TextareaProps } from "@cloudscape-design/components/textarea";
import {
  type FieldPath,
  type FieldValues,
  useController,
  UseControllerProps,
} from "react-hook-form";

export interface TextareaFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** Textarea component props and event handlers */
  textareaProps?: Omit<TextareaProps, "value">;
  /**
   * When set, renders a live "{used} / {maxLength} characters" indicator in the
   * FormField constraint slot, updating as the user types. Informational only —
   * it does not cap input (the zod schema on Save remains the source of truth).
   * Overrides any `formFieldProps.constraintText` when provided.
   */
  maxLength?: number;
}

export default function TextareaField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  textareaProps,
  maxLength,
}: Readonly<TextareaFieldProps<TFieldValues, TName>>) {
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
    ...restTextareaProps
  } = textareaProps || {};

  // Live character count. Reads the controlled value's length so it tracks every
  // keystroke. When set, it takes the constraint slot over any caller-supplied
  // constraintText. Over the limit the visible count is coloured with
  // Cloudscape's error text token so the state reads as visibly wrong while
  // typing. The visible count lives in constraintText (aria-describedby), which
  // is only re-read on focus — so a visually-hidden LiveRegion carries a
  // screen-reader phrasing that is re-announced (politely, debounced) as the
  // count changes. Informational only — input is not capped; the zod schema on
  // Save is the source of truth.
  const valueLength = (fieldValue ?? "").length;
  const overLength = maxLength !== undefined && valueLength > maxLength;
  const constraintText =
    maxLength === undefined ? (
      formFieldProps?.constraintText
    ) : (
      <>
        <Box
          variant="span"
          color={overLength ? "text-status-error" : "inherit"}
          fontSize="body-s"
        >
          {`${valueLength} / ${maxLength} characters`}
        </Box>
        <LiveRegion hidden>
          {`${valueLength} of ${maxLength} characters${
            overLength ? ", over the limit" : ""
          }`}
        </LiveRegion>
      </>
    );

  return (
    <FormField
      {...formFieldProps}
      constraintText={constraintText}
      errorText={fieldError?.message}
    >
      <Textarea
        {...restTextareaProps}
        name={fieldName}
        value={fieldValue}
        ref={fieldRef}
        onChange={(event) => {
          onFieldChange(event.detail.value);
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
