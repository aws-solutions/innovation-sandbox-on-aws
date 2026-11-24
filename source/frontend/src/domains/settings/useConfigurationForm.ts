// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, useState } from "react";
import { FieldValues, useForm, useWatch } from "react-hook-form";

import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { useTrackUnsavedChanges } from "@amzn/innovation-sandbox-frontend/domains/settings/components/UnsavedChangesGuard";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import {
  ConfigSection,
  ConfigWriteSchemas,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

import {
  useGetConfigurationSection,
  usePutConfigurationSection,
} from "./hooks";
import { ConfigurationSectionView } from "./model";
import { SETTINGS_GROUPS, SettingsSearchField } from "./settings-navigation";
import { ConfigurationSectionRequest } from "./types";

function fieldsOf(data: ConfigurationSectionView<ConfigSection>): FieldValues {
  const { lastSavedBy: _savedBy, meta: _meta, ...fields } = data;
  return fields;
}

function blocksSave(error?: { type?: string | number }) {
  // Server checks can recover without edits (e.g. SES verification availability).
  return !!error && error.type !== "server";
}

function reportSaveFailure(
  message: string,
  onError?: (message: string) => void,
) {
  if (onError) onError(message);
  else showErrorToast(message, "Save Failed");
}

/** One form and concurrency token per API section, independent of visible cards. */
export function useConfigurationForm<T extends ConfigSection>(
  section: T,
  data: ConfigurationSectionView<T>,
  searchFields: readonly SettingsSearchField[] = [],
) {
  const [baseline, setBaseline] = useState(data);
  const [conflict, setConflict] = useState<{ savedBy: string | null } | null>(
    null,
  );
  const mutation = usePutConfigurationSection(section);
  const latest = useGetConfigurationSection(section, { enabled: false });
  const methods = useForm<FieldValues>({
    defaultValues: fieldsOf(data),
    resolver: zodResolver(ConfigWriteSchemas[section] as never),
    mode: "all",
  });
  const values = useWatch({ control: methods.control });
  const handledAggregateTime = useRef(data.meta?.lastEditTime);
  const receivedAggregateTime = useRef(data.meta?.lastEditTime);
  receivedAggregateTime.current = data.meta?.lastEditTime;
  const previousValues = useRef(JSON.stringify(values));
  useTrackUnsavedChanges(section, methods.formState.isDirty);

  useEffect(() => {
    const serialized = JSON.stringify(values);
    if (previousValues.current !== serialized) {
      previousValues.current = serialized;
      methods.clearErrors("root");
    }
  }, [values, methods]);
  useEffect(() => {
    if (
      handledAggregateTime.current === data.meta?.lastEditTime ||
      methods.formState.isDirty ||
      conflict
    )
      return;
    handledAggregateTime.current = data.meta?.lastEditTime;
    // An aggregate read can finish after a newer section save or reload.
    if (
      (Date.parse(data.meta?.lastEditTime ?? "") || 0) <
      (Date.parse(baseline.meta?.lastEditTime ?? "") || 0)
    )
      return;
    methods.reset(fieldsOf(data));
    setBaseline(data);
  }, [data, baseline, methods.formState.isDirty, conflict, methods]);

  const ownedFields = (fields?: readonly string[]) =>
    fields ?? Object.keys(fieldsOf(baseline));
  const status = (fields?: readonly string[]) => ({
    dirty: ownedFields(fields).some(
      (field) =>
        JSON.stringify(methods.getValues(field)) !==
        JSON.stringify(fieldsOf(baseline)[field]),
    ),
    invalid:
      ownedFields(fields).some((field) =>
        blocksSave(methods.getFieldState(field).error),
      ) || blocksSave(methods.formState.errors.root?.server),
    conflict: !!conflict,
    needsSetup: baseline.lastSavedBy === null,
  });
  // Section writes replace all fields; other groups retain their persisted values.
  const payload = (fields?: readonly string[]) => ({
    ...fieldsOf(baseline),
    ...Object.fromEntries(
      ownedFields(fields).map((field) => [field, methods.getValues(field)]),
    ),
  });
  const applyIssues = (
    issues: { field?: string; message: string }[],
    fields?: readonly string[],
    type: "validation" | "server" = "validation",
  ) => {
    const root: string[] = [];
    for (const issue of issues) {
      const knownField =
        !!issue.field && methods.getValues(issue.field) !== undefined;
      if (knownField)
        methods.setError(issue.field!, {
          type,
          message: issue.message,
        });
      if (
        !knownField ||
        issue.field === "input" ||
        (fields && !fields.includes(issue.field ?? ""))
      ) {
        const entry = searchFields.find(
          (entry) => entry.section === section && entry.field === issue.field,
        );
        const group = SETTINGS_GROUPS.find(
          (group) => group.id === entry?.group,
        );
        root.push(
          fields && entry && group
            ? `${entry.label} must be corrected in ${group.label} before saving. ${issue.message}`
            : issue.message,
        );
      }
    }
    if (root.length)
      methods.setError("root.server", { type, message: root.join("; ") });
  };
  const validate = (fields?: readonly string[]) => {
    const result = ConfigWriteSchemas[section].safeParse(payload(fields));
    if (!result.success) {
      applyIssues(
        result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
        fields,
      );
      return false;
    }
    return !conflict;
  };
  const accept = (updated: ConfigurationSectionView<T>) => {
    // Consume any deferred prop before accepting the save or reload response.
    handledAggregateTime.current = receivedAggregateTime.current;
    methods.reset(fieldsOf(updated));
    setBaseline(updated);
    setConflict(null);
  };
  const handleSaveError = async (
    error: unknown,
    fields?: readonly string[],
    onError?: (message: string) => void,
  ) => {
    if (error instanceof ApiError && error.statusCode === 409) {
      setConflict({ savedBy: null });
      // Fetch the editor's name; preserve the draft and token until explicit Reload.
      const result = await latest.refetch();
      setConflict({ savedBy: result.data?.lastSavedBy ?? null });
      onError?.("Reload latest values before saving.");
      return;
    }
    if (error instanceof ApiError && error.statusCode === 400) {
      const issues = (error.data?.errors ?? []) as {
        field?: string;
        message: string;
      }[];
      if (issues.length) {
        applyIssues(issues, fields, "server");
        onError?.(issues.map((issue) => issue.message).join("; "));
      } else
        reportSaveFailure("Failed to save settings: validation error", onError);
      return;
    }
    reportSaveFailure(
      `Failed to save settings: ${error instanceof Error ? error.message : "Unknown error"}`,
      onError,
    );
  };
  const save = async (
    fields?: readonly string[],
    onError?: (message: string) => void,
  ) => {
    if (!validate(fields)) return false;
    if (!status(fields).dirty && baseline.lastSavedBy !== null) return true;
    try {
      const updated = await mutation.mutateAsync({
        ...payload(fields),
        ...(baseline.meta?.lastEditTime
          ? { meta: { lastEditTime: baseline.meta.lastEditTime } }
          : {}),
      } as ConfigurationSectionRequest<T>);
      accept(updated);
      return true;
    } catch (error) {
      await handleSaveError(error, fields, onError);
      return false;
    }
  };
  const discard = (fields?: readonly string[]) => {
    if (fields)
      for (const field of fields)
        methods.resetField(field, { defaultValue: fieldsOf(baseline)[field] });
    else methods.reset(fieldsOf(baseline));
    methods.clearErrors("root");
  };
  const reload = async () => {
    const result = await latest.refetch();
    if (result.error || !result.data) {
      showErrorToast("Failed to reload the latest settings.", "Reload failed");
      return false;
    }
    accept(result.data as ConfigurationSectionView<T>);
    return true;
  };
  return {
    methods,
    baseline,
    conflict,
    status,
    payload,
    validate,
    save,
    discard,
    reload,
    busy: mutation.isPending || latest.isFetching,
  };
}
export type ConfigurationForm<T extends ConfigSection = ConfigSection> =
  ReturnType<typeof useConfigurationForm<T>>;
