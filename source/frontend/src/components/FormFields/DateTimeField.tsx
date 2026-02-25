// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  DatePicker,
  FormField,
  FormFieldProps,
  SpaceBetween,
  TimeInput,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";
import {
  FieldPath,
  FieldValues,
  UseControllerProps,
  useController,
} from "react-hook-form";

export interface DateTimeFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
}

/**
 * Date and time picker field component that integrates with React Hook Form.
 * Manages date and time separately and combines them into a single ISO string value.
 */
export default function DateTimeField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
}: DateTimeFieldProps<TFieldValues, TName>) {
  const {
    field: { onBlur: onFieldBlur, onChange: onFieldChange, value: fieldValue },
    fieldState: { error, invalid },
  } = useController(controllerProps);

  // Track date and time separately for user input
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedTime, setSelectedTime] = useState<string>("");

  // Sync local state when fieldValue changes externally (e.g., form reset, setValue)
  useEffect(() => {
    if (fieldValue) {
      const dt = DateTime.fromISO(fieldValue);
      setSelectedDate(dt.toFormat("yyyy-MM-dd"));
      setSelectedTime(dt.toFormat("HH:mm"));
    } else {
      setSelectedDate("");
      setSelectedTime("");
    }
  }, [fieldValue]);

  const onDateChange = (date: string) => {
    setSelectedDate(date);
    updateCombinedDateTime(date, selectedTime);
  };

  const onTimeChange = (time: string) => {
    setSelectedTime(time);
    updateCombinedDateTime(selectedDate, time);
  };

  const updateCombinedDateTime = (date: string, time: string) => {
    // Only combine if both date and time are valid
    if (date && time) {
      const combinedDateTime = DateTime.fromFormat(
        `${date} ${time}`,
        "yyyy-MM-dd HH:mm",
      );

      if (combinedDateTime.isValid) {
        onFieldChange(combinedDateTime.toUTC().toISO());
        return;
      }
    }
    onFieldChange(undefined);
  };

  return (
    <FormField {...formFieldProps} errorText={error?.message}>
      <SpaceBetween size="xxs">
        <SpaceBetween size="l" direction="horizontal" alignItems="center">
          <Box>
            <FormField label={<Box variant="small">Date</Box>}>
              <DatePicker
                invalid={invalid}
                onChange={({ detail: { value } }) => onDateChange(value)}
                placeholder="YYYY/MM/DD"
                value={selectedDate}
                onBlur={onFieldBlur}
              />
            </FormField>
          </Box>
          <Box>
            <FormField label={<Box variant="small">Time</Box>}>
              <TimeInput
                invalid={invalid}
                onChange={({ detail: { value } }) => onTimeChange(value)}
                format="hh:mm"
                placeholder="hh:mm"
                value={selectedTime}
                onBlur={onFieldBlur}
              />
            </FormField>
          </Box>
        </SpaceBetween>
      </SpaceBetween>
    </FormField>
  );
}
