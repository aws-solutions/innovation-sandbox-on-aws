// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Autosuggest,
  AutosuggestProps,
  Box,
  Button,
  FormField,
  Modal,
  SegmentedControl,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  PRINCIPAL_SEARCH_MIN_CHARS,
  useGetPrincipals,
  useResolvePrincipal,
} from "@amzn/innovation-sandbox-frontend/domains/principals/hooks";
import type { IdcPrincipalView } from "@amzn/innovation-sandbox-frontend/domains/principals/model";
import { useLatest } from "@amzn/innovation-sandbox-frontend/hooks/useLatest";
import type { PrincipalSearchType } from "@amzn/innovation-sandbox-shared/types/principal.js";

const DEBOUNCE_MS = 200;
const RESULT_LIMIT = 20;

function getResolveType(
  componentType: PrincipalSearchType,
  selectedType: "users" | "groups",
): "users" | "groups" {
  if (componentType === "users") return "users";
  if (componentType === "groups") return "groups";
  return selectedType;
}

export type PrincipalTypeaheadProps = {
  onSelect: (principal: IdcPrincipalView) => void;
  shouldExclude?: (principal: IdcPrincipalView) => boolean;
  type?: PrincipalSearchType;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  enablePrincipalSearch?: boolean;
};

export const PrincipalTypeahead = ({
  onSelect,
  shouldExclude = () => false,
  type = "all",
  placeholder,
  ariaLabel = "Search or enter user email / group name",
  disabled = false,
  enablePrincipalSearch = true,
}: PrincipalTypeaheadProps) => {
  const [inputValue, setInputValue] = useState("");
  const [debouncedValue, setDebouncedValue] = useState("");
  const [errorText, setErrorText] = useState("");
  const [pendingGroupSelection, setPendingGroupSelection] =
    useState<IdcPrincipalView | null>(null);
  const [selectedType, setSelectedType] = useState<"users" | "groups">(
    type === "groups" ? "groups" : "users",
  );
  const onSelectRef = useLatest(onSelect);
  const shouldExcludeRef = useLatest(shouldExclude);
  const disabledRef = useLatest(disabled);
  const resolveRequestIdRef = useRef(0);

  useEffect(
    () => () => {
      resolveRequestIdRef.current += 1;
    },
    [],
  );

  // Debounce for typeahead search
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedValue(inputValue);
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [inputValue]);

  // Use selectedType for search filtering when type="all"
  const searchType: PrincipalSearchType = type === "all" ? selectedType : type;

  // Typeahead suggestions (only when enablePrincipalSearch is true)
  const { data, isFetching } = useGetPrincipals(
    searchType,
    debouncedValue,
    RESULT_LIMIT,
    { enabled: enablePrincipalSearch },
  );

  // Exact resolve mutation (for manual entry)
  const resolvePrincipal = useResolvePrincipal();

  const principalsByValue = useMemo(() => {
    const map = new Map<string, IdcPrincipalView>();
    if (!enablePrincipalSearch) return map;
    (data?.principals ?? [])
      .filter((p) => !shouldExclude(p))
      .forEach((p) => {
        map.set(p.principalId, p);
      });
    return map;
  }, [data, shouldExclude, enablePrincipalSearch]);

  const options: AutosuggestProps.Options = useMemo(() => {
    return Array.from(principalsByValue.values()).map((p) => ({
      value: p.principalId,
      label: p.displayName,
      description: p.email,
      labelTag: p.principalType === "GROUP" ? "Group" : "User",
    }));
  }, [principalsByValue]);

  const emptyFallbackByType: Record<PrincipalSearchType, string> = {
    users: "Type an email and press Enter to add",
    groups: "Type a group name and press Enter to add",
    all: "Type an email or group name and press Enter to add",
  };

  const empty = enablePrincipalSearch
    ? `Type at least ${PRINCIPAL_SEARCH_MIN_CHARS} characters to search`
    : emptyFallbackByType[type];

  // Handle selection from the typeahead dropdown
  const handleSelected: AutosuggestProps["onSelect"] = ({ detail }) => {
    if (disabledRef.current) return;
    const selected = principalsByValue.get(detail.value);
    if (!selected) {
      // User pressed Enter on text that didn't match a dropdown item —
      // fall through to manual resolve.
      handleManualResolve();
      return;
    }
    setInputValue("");
    setDebouncedValue("");
    setErrorText("");
    if (selected.principalType === "GROUP") {
      setPendingGroupSelection(selected);
      return;
    }
    onSelectRef.current(selected);
  };

  // Manual resolve: user typed a value and pressed Enter or clicked Add
  const handleManualResolve = async () => {
    if (disabledRef.current) return;
    const trimmed = inputValue.trim();
    if (trimmed.length === 0) return;
    const requestId = ++resolveRequestIdRef.current;
    setErrorText("");

    const resolveType = getResolveType(type, selectedType);

    try {
      const principal = await resolvePrincipal.mutateAsync({
        identifier: trimmed,
        type: resolveType,
      });
      if (requestId !== resolveRequestIdRef.current || disabledRef.current) {
        return;
      }

      if (shouldExcludeRef.current(principal)) {
        setErrorText("This principal is already assigned.");
        return;
      }

      setInputValue("");
      setDebouncedValue("");
      if (principal.principalType === "GROUP") {
        setPendingGroupSelection(principal);
      } else {
        onSelectRef.current(principal);
      }
    } catch (err: unknown) {
      if (requestId !== resolveRequestIdRef.current || disabledRef.current) {
        return;
      }
      if (err instanceof Error && "statusCode" in err) {
        const statusCode = (err as { statusCode: number }).statusCode;
        if (statusCode === 404) {
          setErrorText("Principal not found.");
          return;
        }
      }
      setErrorText("Failed to resolve principal.");
    }
  };

  const confirmGroup = () => {
    if (
      pendingGroupSelection &&
      !disabledRef.current &&
      !shouldExcludeRef.current(pendingGroupSelection)
    ) {
      onSelectRef.current(pendingGroupSelection);
    }
    setPendingGroupSelection(null);
  };

  const cancelGroup = () => {
    setPendingGroupSelection(null);
  };

  const PLACEHOLDER_BY_TYPE: Record<"users" | "groups", string> = {
    users: "Search or enter email",
    groups: "Search or enter group name",
  };
  const activeType = getResolveType(type, selectedType);
  const defaultPlaceholder = placeholder ?? PLACEHOLDER_BY_TYPE[activeType];

  const controls = (
    <SpaceBetween direction="vertical" size="xs">
      {type === "all" && (
        <SegmentedControl
          selectedId={selectedType}
          onChange={({ detail }) =>
            setSelectedType(detail.selectedId as "users" | "groups")
          }
          options={[
            { id: "users", text: "User", disabled: resolvePrincipal.isPending },
            {
              id: "groups",
              text: "Group",
              disabled: resolvePrincipal.isPending,
            },
          ]}
          label="Principal type"
        />
      )}
      <Autosuggest
        value={inputValue}
        onChange={({ detail }) => {
          setInputValue(detail.value);
          if (errorText) setErrorText("");
        }}
        onSelect={handleSelected}
        options={options}
        filteringType="manual"
        loadingText="Loading principals…"
        statusType={
          isFetching || resolvePrincipal.isPending ? "loading" : "finished"
        }
        empty={empty}
        placeholder={defaultPlaceholder}
        ariaLabel={ariaLabel}
        disabled={disabled || resolvePrincipal.isPending}
        enteredTextLabel={(value) => `Add: "${value}"`}
      />
    </SpaceBetween>
  );

  return (
    <>
      <FormField
        errorText={errorText}
        constraintText={
          resolvePrincipal.isPending ? (
            <StatusIndicator type="loading">
              Resolving principal…
            </StatusIndicator>
          ) : undefined
        }
      >
        {controls}
      </FormField>
      <GroupConfirmationModal
        pendingGroupSelection={pendingGroupSelection}
        disabled={disabled}
        onConfirm={confirmGroup}
        onCancel={cancelGroup}
      />
    </>
  );
};

// --- Shared group confirmation modal ---

type GroupConfirmationModalProps = {
  pendingGroupSelection: IdcPrincipalView | null;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

const GroupConfirmationModal = ({
  pendingGroupSelection,
  disabled,
  onConfirm,
  onCancel,
}: GroupConfirmationModalProps) => (
  <Modal
    visible={pendingGroupSelection !== null}
    onDismiss={onCancel}
    header="Confirm group assignment"
    footer={
      <Box float="right">
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={disabled}>
            Add group
          </Button>
        </SpaceBetween>
      </Box>
    }
  >
    <Alert type="info">
      All current and future members of{" "}
      <strong>{pendingGroupSelection?.displayName}</strong> will receive sandbox
      access.
    </Alert>
  </Modal>
);
