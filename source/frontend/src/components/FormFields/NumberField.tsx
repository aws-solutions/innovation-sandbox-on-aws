// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type FieldPath, type FieldValues } from "react-hook-form";

import InputField, {
  type InputFieldProps,
} from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";

/**
 * NumberField is a generic, RHF-controlled numeric input. It is a thin
 * specialization of {@link InputField} that fixes the underlying control to
 * `type="number"` / `inputMode="numeric"`, so InputField's tested string→number
 * coercion (empty input → "", otherwise `parseFloat`) applies and callers no
 * longer repeat those input props per field. The controller/FormField API is
 * identical to the other FormFields components. Extra `inputProps` (e.g.
 * `placeholder`, `disabled`) still pass through, and an explicit `type` /
 * `inputMode` there overrides the numeric defaults.
 */
export type NumberFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = InputFieldProps<TFieldValues, TName>;

export default function NumberField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({ inputProps, ...rest }: Readonly<NumberFieldProps<TFieldValues, TName>>) {
  return (
    <InputField
      {...rest}
      inputProps={{ type: "number", inputMode: "numeric", ...inputProps }}
    />
  );
}
