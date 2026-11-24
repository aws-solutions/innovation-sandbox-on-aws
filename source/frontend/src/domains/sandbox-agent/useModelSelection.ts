// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";

/**
 * Holds the chat model picker's per-session selection (Task 6.10 Workstream B).
 * Pure UI-state logic: it operates only on the list of allowed model IDs and an
 * optional default, so it is independent of where that list comes from (the
 * lease-scoped context endpoint in Task 4.3, once it exists).
 *
 * Rules:
 *  - Initial selection is the default when it is allowed, else the first allowed
 *    model, else undefined (empty list).
 *  - If the current selection drops out of `allowedModelIds` (e.g. a model is
 *    disabled mid-session), it falls back to the same default-then-first rule.
 *  - The selection persists across renders until the user changes it or it
 *    becomes unavailable.
 */
function resolveFallback(
  allowedModelIds: string[],
  defaultModelId: string | undefined,
): string | undefined {
  if (
    defaultModelId !== undefined &&
    allowedModelIds.includes(defaultModelId)
  ) {
    return defaultModelId;
  }
  return allowedModelIds[0];
}

export function useModelSelection(
  allowedModelIds: string[],
  defaultModelId?: string,
): {
  selectedModelId: string | undefined;
  setSelectedModelId: (modelId: string) => void;
} {
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(
    () => resolveFallback(allowedModelIds, defaultModelId),
  );

  // Reconcile when the allowed set changes: if the current pick is no longer
  // allowed, fall back to default-then-first.
  useEffect(() => {
    if (
      selectedModelId === undefined ||
      !allowedModelIds.includes(selectedModelId)
    ) {
      setSelectedModelId(resolveFallback(allowedModelIds, defaultModelId));
    }
    // Reconcile only when the inputs change, not on every selection.
  }, [allowedModelIds, defaultModelId]);

  const select = useCallback((modelId: string) => {
    setSelectedModelId(modelId);
  }, []);

  return { selectedModelId, setSelectedModelId: select };
}
