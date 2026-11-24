// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  FormField,
  Grid,
  Input,
  LiveRegion,
  SpaceBetween,
  TokenGroup,
} from "@cloudscape-design/components";
import type { FormFieldProps } from "@cloudscape-design/components/form-field";
import type { InputProps } from "@cloudscape-design/components/input";
import { useEffect, useState } from "react";
import {
  type FieldPath,
  type FieldValues,
  useController,
  UseControllerProps,
} from "react-hook-form";

import { sortedCaseInsensitive } from "@amzn/innovation-sandbox-frontend/helpers/sorted-case-insensitive";

export interface TokenListFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> {
  /** React Hook Form controller configuration */
  controllerProps: UseControllerProps<TFieldValues, TName, TFieldValues>;
  /**
   * FormField wrapper props (label, description, constraintText, etc.).
   * `errorText` (driven by the RHF field error) and `warningText` (driven by the
   * input-time limit message) are managed internally and cannot be overridden.
   */
  formFieldProps?: Omit<FormFieldProps, "errorText" | "warningText">;
  /** Input component props (placeholder, disabled, etc.). value/onChange/onKeyDown are managed internally. */
  inputProps?: Omit<InputProps, "value" | "onChange" | "onKeyDown">;
  /** Builds the dismiss (remove) aria-label for each token. Defaults to `Remove ${token}`. */
  getDismissLabel?: (token: string) => string;
  /**
   * Maximum number of tokens. Once reached, further adds are blocked at input
   * time with an inline message. The zod schema on Save remains the source of
   * truth; this is the at-input-time guard so the limit is not only discovered
   * on submit.
   */
  maxItems?: number;
  /** Maximum length of a single token. A longer entry is rejected at input time. */
  maxItemLength?: number;
  /**
   * Display the tokens sorted alphabetically (case-insensitive) rather than in
   * insertion order. Display-only: the stored value keeps its underlying order,
   * so this does not rewrite the field or affect what is saved.
   */
  sorted?: boolean;
  /**
   * Plural noun for the "N / max" item count shown when `maxItems` is set
   * (e.g. "groups" → "3 / 100 groups"). Defaults to "items".
   */
  itemNoun?: string;
}

/**
 * TokenListField RHF controlled component for editing a list of free-text
 * string values. Typing a value and pressing Enter or selecting Add appends it
 * to the list (whitespace-only and duplicate entries are ignored and left in
 * the input so they are not silently discarded); each value is rendered as a
 * dismissible token. The underlying field value is a `string[]`.
 */
export default function TokenListField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  controllerProps,
  formFieldProps,
  inputProps,
  getDismissLabel = (token) => `Remove ${token}`,
  maxItems,
  maxItemLength,
  sorted = false,
  itemNoun = "items",
}: Readonly<TokenListFieldProps<TFieldValues, TName>>) {
  const {
    field: { value, onChange },
    fieldState: { error },
  } = useController(controllerProps);
  const [draft, setDraft] = useState("");
  const readOnly = inputProps?.readOnly ?? false;
  // Inline message for an input-time limit rejection (over-length / over-count).
  // Surfaced via the FormField `warningText` (amber/advisory) slot, not
  // `errorText` (red): a capacity limit is a soft "can't add this" notice, not a
  // schema-invalid field. This matches the app's convention for soft limits
  // (e.g. TagEditorField). The RHF schema `error` keeps the red errorText slot.
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const items: string[] = value ?? [];
  // The tokens as displayed. When `sorted`, show them alphabetically
  // (case-insensitive) without mutating the stored value — dismiss maps back to
  // the value, not the display index (see onDismiss). New entries are still
  // appended to the underlying array in insertion order.
  const displayItems = sorted ? sortedCaseInsensitive(items) : items;

  // Clear a stale limit message when the controlled value changes from outside
  // the component — e.g. SectionForm's conflict Reload calls methods.reset(),
  // replacing the list without unmounting this field. Without this, an
  // over-limit message could linger over a now-valid list until the next edit.
  useEffect(() => {
    setLimitMessage(null);
  }, [value]);

  // Live character counter for the entry currently being typed, mirroring the
  // trimmed length that will actually be stored/validated. Only shown when a
  // per-item length limit is configured. When the draft exceeds the limit the
  // count is coloured with Cloudscape's error text token, so an over-limit state
  // reads as visibly wrong while typing instead of a calm neutral hint (the
  // entry is still soft-blocked on add — nothing is truncated); otherwise
  // `inherit` so it matches the surrounding neutral constraintText.
  const draftLength = draft.trim().length;
  const overItemLength =
    maxItemLength !== undefined && draftLength > maxItemLength;
  const counterNode =
    maxItemLength === undefined ? undefined : (
      <>
        <Box
          variant="span"
          color={overItemLength ? "text-status-error" : "inherit"}
          fontSize="body-s"
        >
          {`${draftLength} / ${maxItemLength} characters`}
        </Box>
        {/* The visible count sits in constraintText (aria-describedby), only
            re-read on focus; a visually-hidden LiveRegion re-announces the draft
            count (politely, debounced) as the user types. */}
        <LiveRegion hidden>
          {`${draftLength} of ${maxItemLength} characters${
            overItemLength ? ", over the limit" : ""
          }`}
        </LiveRegion>
      </>
    );
  // Live "N / max items" count of the whole list (distinct from the per-entry
  // character counter above). Shown when a max count is configured, so the
  // remaining capacity is visible at a glance rather than only a static "Up to
  // N" hint. Neutral styling — the at-limit case is already handled by the
  // add-time block message, so this stays an informational count.
  const itemCountNode =
    maxItems === undefined ? undefined : (
      <>
        <Box variant="span" fontSize="body-s">
          {`${items.length} / ${maxItems} ${itemNoun}`}
        </Box>
        {/* The visible count is in constraintText (aria-describedby), only
            re-read on focus; a visually-hidden LiveRegion re-announces the new
            count as items are added/removed, mirroring the char counter so both
            counts announce consistently. */}
        <LiveRegion hidden>
          {`${items.length} of ${maxItems} ${itemNoun}`}
        </LiveRegion>
      </>
    );

  // Compose the caller's static hint, the item count, and the per-entry char
  // counter into the single FormField constraint slot, separated by "·".
  // constraintText accepts a node, so the char counter's conditional error
  // colour survives (a plain string would flatten it to neutral).
  const staticHint = formFieldProps?.constraintText;
  const constraintParts = [
    { key: "hint", node: staticHint },
    { key: "count", node: itemCountNode },
    { key: "chars", node: counterNode },
  ].filter((part) => part.node);
  const constraintText = constraintParts.length
    ? constraintParts.map((part, i) => (
        <span key={part.key}>
          {i > 0 && " · "}
          {part.node}
        </span>
      ))
    : undefined;

  const addItem = () => {
    if (readOnly) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      // Whitespace-only: leave the typed text in place (no silent discard) and
      // surface no new message.
      return;
    }
    if (items.includes(trimmed)) {
      // Duplicate: keep the draft and explain why nothing was added, instead of
      // silently doing nothing (which reads as the control being broken).
      setLimitMessage(`"${trimmed}" has already been added.`);
      return;
    }
    if (maxItemLength !== undefined && trimmed.length > maxItemLength) {
      setLimitMessage(
        `Each entry must be ${maxItemLength} characters or fewer.`,
      );
      return;
    }
    if (maxItems !== undefined && items.length >= maxItems) {
      setLimitMessage(
        `You can add a maximum of ${maxItems} entries. Remove one to add another.`,
      );
      return;
    }
    onChange([...items, trimmed]);
    setDraft("");
    setLimitMessage(null);
  };

  return (
    <FormField
      {...formFieldProps}
      constraintText={constraintText}
      errorText={error?.message}
      // Only show the soft limit warning when there is no schema error, so the
      // two never render together (Cloudscape warns when both are set) and a
      // real field error always takes precedence.
      warningText={error?.message ? undefined : limitMessage}
    >
      <SpaceBetween size="xs">
        <Grid gridDefinition={[{ colspan: 9 }, { colspan: 3 }]}>
          <Input
            {...inputProps}
            value={draft}
            onChange={({ detail }) => {
              setDraft(detail.value);
              if (limitMessage) setLimitMessage(null);
            }}
            onKeyDown={(e) => {
              if (e.detail.key === "Enter") {
                e.preventDefault();
                addItem();
              }
            }}
          />
          <Button
            formAction="none"
            onClick={addItem}
            disabled={readOnly || !draft.trim()}
          >
            Add
          </Button>
        </Grid>
        <TokenGroup
          readOnly={readOnly}
          items={displayItems.map((item) => ({
            label: item,
            dismissLabel: getDismissLabel(item),
          }))}
          onDismiss={({ detail: { itemIndex } }) => {
            // Dismiss by the token's VALUE, not by index into `items`: when
            // `sorted` is on, the displayed order differs from the stored order,
            // so an index into `displayItems` would remove the wrong entry.
            // Removing changes `value`, so the limit message is cleared by the
            // value-change effect above; no explicit clear needed here.
            const removed = displayItems[itemIndex];
            onChange(items.filter((item) => item !== removed));
          }}
        />
      </SpaceBetween>
    </FormField>
  );
}
