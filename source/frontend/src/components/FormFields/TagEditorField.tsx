// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import { AttributeEditor, FormField } from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import {
  ArrayPath,
  Control,
  FieldArray,
  FieldValues,
  Path,
  useFieldArray,
  useFormContext,
} from "react-hook-form";

export interface TagItem {
  key: string;
  value?: string;
}

export interface TagEditorFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends ArrayPath<TFieldValues> = ArrayPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: {
    control: Control<TFieldValues>;
    name: TName;
  };
  /** FormField wrapper props (label, description, constraintText, etc.) */
  formFieldProps?: Omit<FormFieldProps, "errorText">;
  /** Maximum number of tags allowed */
  maxTags?: number;
  /** Placeholder text for the key input */
  keyPlaceholder?: string;
  /** Placeholder text for the value input */
  valuePlaceholder?: string;
}

/**
 * TagEditorField RHF controlled component for managing key-value tags in forms.
 * @requires FormProvider - This component must be used within a FormProvider context
 */
export default function TagEditorField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends ArrayPath<TFieldValues> = ArrayPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  maxTags,
  keyPlaceholder,
  valuePlaceholder,
}: TagEditorFieldProps<TFieldValues, TName>) {
  const { fields, append, remove } = useFieldArray({
    control: controllerProps.control,
    name: controllerProps.name,
  });

  const { trigger } = useFormContext();
  const handleAdd = () => {
    append({ key: "", value: "" } as FieldArray<TFieldValues, TName>);
  };

  const handleRemove = (itemIndex: number) => {
    remove(itemIndex);
    trigger();
  };

  return (
    <FormField {...formFieldProps}>
      <AttributeEditor
        items={fields}
        onAddButtonClick={handleAdd}
        onRemoveButtonClick={({ detail: { itemIndex } }) =>
          handleRemove(itemIndex)
        }
        disableAddButton={maxTags !== undefined && fields.length >= maxTags}
        definition={[
          {
            label: "Key",
            // prettier-ignore
            control: (_item, itemIndex) => ( // NOSONAR typescript:S6478 - AttributeEditor API requires control render functions
              <InputField
                controllerProps={{
                  control: controllerProps.control,
                  name: `${controllerProps.name}.${itemIndex}.key` as Path<TFieldValues>,
                }}
                inputProps={{
                  placeholder: keyPlaceholder,
                  onChange: () => {trigger()},
                }}
              />
            ),
          },
          {
            label: "Value",
            // prettier-ignore
            control: (_item, itemIndex) => ( // NOSONAR typescript:S6478 - AttributeEditor API requires control render functions
              <InputField
                controllerProps={{
                  control: controllerProps.control,
                  name: `${controllerProps.name}.${itemIndex}.value` as Path<TFieldValues>,
                }}
                inputProps={{
                  placeholder: valuePlaceholder,
                  onChange: () => {trigger()}
                }}
              />
            ),
          },
        ]}
        addButtonText="Add tag"
        removeButtonText="Remove"
        empty="No tags added"
        additionalInfo={
          maxTags !== undefined && fields.length > 0
            ? `${fields.length} of ${maxTags} tags used`
            : undefined
        }
      />
    </FormField>
  );
}
