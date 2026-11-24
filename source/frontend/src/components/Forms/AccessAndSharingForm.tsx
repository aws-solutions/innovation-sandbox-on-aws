// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Button,
  Container,
  FormField,
  Header,
  Multiselect,
  SpaceBetween,
} from "@cloudscape-design/components";
import type { MultiselectProps } from "@cloudscape-design/components/multiselect";
import { useEffect, useMemo, useState } from "react";
import { useController, useFormContext, useWatch } from "react-hook-form";

import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import type { AccessAndSharingFormValues } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import {
  PermissionSetsTable,
  withoutDefaultPermissionSet,
} from "@amzn/innovation-sandbox-frontend/components/PermissionSetsTable";
import {
  BUILT_IN_PERMISSION_SET_NAME_SUFFIX,
  isBuiltInPermissionSet,
} from "@amzn/innovation-sandbox-frontend/domains/permissionSets/helpers";
import {
  PERMISSION_SETS_QUERY_MAX_LENGTH,
  usePermissionSets,
} from "@amzn/innovation-sandbox-frontend/domains/permissionSets/hooks";
import type { PermissionSetView } from "@amzn/innovation-sandbox-frontend/domains/permissionSets/model";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import {
  MAX_ALLOWED_PERMISSION_SETS,
  type PermissionSetReference,
} from "@amzn/innovation-sandbox-shared/types/permission-set";

const LAZY_CATALOG_OPTIONS = {
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
} as const;

interface AccessAndSharingFormProps {
  disabled?: boolean;
  leaseSharingEnabled?: boolean;
  allowedPermissionSetsDescription?: string;
  bootstrapBuiltInDefault?: boolean;
}

const toOption = (
  permissionSet: PermissionSetReference | PermissionSetView,
): MultiselectProps.Option => ({
  value: permissionSet.permissionSetArn,
  label: permissionSet.name ?? permissionSet.permissionSetArn,
  description: permissionSet.description,
});

const toReference = (
  permissionSet: PermissionSetReference | PermissionSetView,
): PermissionSetReference => ({
  permissionSetArn: permissionSet.permissionSetArn,
  permissionSetId: permissionSet.permissionSetId,
  name: permissionSet.name,
  description: permissionSet.description,
  sessionDuration: permissionSet.sessionDuration,
  availability:
    "availability" in permissionSet ? permissionSet.availability : "AVAILABLE",
});

const boundedQuery = (query: string | undefined) =>
  query?.trim().slice(0, PERMISSION_SETS_QUERY_MAX_LENGTH) ?? "";

type LoadItemsDetail = {
  filteringText: string;
  firstPage: boolean;
  samePage: boolean;
};

function getSharingState(
  leaseSharingEnabled: boolean,
  allowOwnerToShareLease: boolean,
): { description: string; enabled: boolean } {
  if (leaseSharingEnabled) {
    return {
      description:
        "When enabled, the lease owner can share sandbox access with additional users and groups",
      enabled: true,
    };
  }

  if (allowOwnerToShareLease) {
    return {
      description:
        "Lease sharing is globally disabled. You can turn sharing off, but cannot enable it again until global sharing is enabled.",
      enabled: true,
    };
  }

  return {
    description:
      "Lease sharing is globally disabled. Enable it in the global configuration to allow owners to share leases.",
    enabled: false,
  };
}

export type { AccessAndSharingFormValues } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";

export function AccessAndSharingForm({
  disabled = false,
  leaseSharingEnabled = false,
  allowedPermissionSetsDescription,
  bootstrapBuiltInDefault = true,
}: Readonly<AccessAndSharingFormProps>) {
  const { clearErrors, control, resetField, setError, setValue } =
    useFormContext<AccessAndSharingFormValues>();
  const { isAdmin } = useUser();
  const allowOwnerToShareLease = useWatch({
    control,
    name: "allowOwnerToShareLease",
  });
  const defaultPermissionSet = useWatch({
    control,
    name: "defaultPermissionSet",
  });
  const allowedPermissionSets =
    useWatch({ control, name: "allowedPermissionSets" }) ?? [];

  const {
    fieldState: { error: defaultPermissionSetError },
  } = useController({
    control,
    name: "defaultPermissionSet",
  });
  const {
    field: { onBlur: onPermissionSetsBlur, ref: permissionSetsRef },
    fieldState: { error: allowedPermissionSetsError },
  } = useController({
    control,
    name: "allowedPermissionSets",
  });

  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogEnabled, setCatalogEnabled] = useState(false);

  const bootstrapCatalog = usePermissionSets(
    BUILT_IN_PERMISSION_SET_NAME_SUFFIX,
    {
      ...LAZY_CATALOG_OPTIONS,
      enabled: bootstrapBuiltInDefault && defaultPermissionSet === undefined,
    },
  );
  const catalog = usePermissionSets(catalogQuery, {
    ...LAZY_CATALOG_OPTIONS,
    enabled: catalogEnabled,
  });

  const knownPermissionSets = useMemo(() => {
    const byArn = new Map<string, PermissionSetReference>();
    [
      ...(defaultPermissionSet ? [defaultPermissionSet] : []),
      ...allowedPermissionSets,
      ...bootstrapCatalog.permissionSets,
      ...catalog.permissionSets,
    ].forEach((permissionSet) =>
      byArn.set(permissionSet.permissionSetArn, toReference(permissionSet)),
    );
    return byArn;
  }, [
    allowedPermissionSets,
    bootstrapCatalog.permissionSets,
    catalog.permissionSets,
    defaultPermissionSet,
  ]);

  useEffect(() => {
    if (!bootstrapBuiltInDefault || defaultPermissionSet !== undefined) {
      return;
    }

    const builtInPermissionSet = bootstrapCatalog.permissionSets.find(
      isBuiltInPermissionSet,
    );
    if (!builtInPermissionSet) {
      return;
    }

    const builtInReference = toReference(builtInPermissionSet);

    resetField("defaultPermissionSet", {
      defaultValue: builtInReference,
    });
    resetField("allowedPermissionSets", {
      defaultValue: withoutDefaultPermissionSet(
        builtInReference,
        allowedPermissionSets,
      ),
    });
  }, [
    allowedPermissionSets,
    bootstrapCatalog.permissionSets,
    bootstrapBuiltInDefault,
    defaultPermissionSet,
    resetField,
  ]);

  const selectedPermissionSets = useMemo(
    () => [
      ...(defaultPermissionSet ? [defaultPermissionSet] : []),
      ...withoutDefaultPermissionSet(
        defaultPermissionSet,
        allowedPermissionSets,
      ),
    ],
    [allowedPermissionSets, defaultPermissionSet],
  );

  const updateAllowedPermissionSets = (
    permissionSets: PermissionSetReference[],
  ) => {
    setValue("allowedPermissionSets", permissionSets, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const removeAllowedPermissionSet = (
    permissionSet: PermissionSetReference,
  ) => {
    updateAllowedPermissionSets(
      allowedPermissionSets.filter(
        ({ permissionSetArn }) =>
          permissionSetArn !== permissionSet.permissionSetArn,
      ),
    );
  };

  const setDefaultPermissionSet = (nextDefault: PermissionSetReference) => {
    if (
      nextDefault.permissionSetArn === defaultPermissionSet?.permissionSetArn
    ) {
      return;
    }

    const nextAllowedPermissionSets = selectedPermissionSets.filter(
      ({ permissionSetArn }) =>
        permissionSetArn !== nextDefault.permissionSetArn,
    );

    clearErrors(["defaultPermissionSet", "allowedPermissionSets"]);
    setValue("defaultPermissionSet", nextDefault, {
      shouldDirty: true,
      shouldValidate: true,
    });
    setValue("allowedPermissionSets", nextAllowedPermissionSets, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const getSelectedPermissionSets = (
    selectedOptions: ReadonlyArray<MultiselectProps.Option>,
  ): PermissionSetReference[] => {
    const selectedByArn = new Map<string, PermissionSetReference>();
    selectedOptions.forEach((option) => {
      const permissionSet = option.value
        ? knownPermissionSets.get(option.value)
        : undefined;
      if (permissionSet) {
        selectedByArn.set(permissionSet.permissionSetArn, permissionSet);
      }
    });

    // The default option is disabled in the selector, but preserve it
    // defensively if a change event is emitted without it.
    if (
      defaultPermissionSet &&
      !selectedByArn.has(defaultPermissionSet.permissionSetArn)
    ) {
      selectedByArn.set(
        defaultPermissionSet.permissionSetArn,
        defaultPermissionSet,
      );
    }

    return [...selectedByArn.values()];
  };

  const updateSelectedPermissionSets = (
    selectedOptions: ReadonlyArray<MultiselectProps.Option>,
  ) => {
    const nextSelectedPermissionSets =
      getSelectedPermissionSets(selectedOptions);

    if (nextSelectedPermissionSets.length > MAX_ALLOWED_PERMISSION_SETS) {
      setError("allowedPermissionSets", {
        type: "max",
        message: `Choose no more than ${MAX_ALLOWED_PERMISSION_SETS} permission sets.`,
      });
      return;
    }

    const nextDefault = defaultPermissionSet ?? nextSelectedPermissionSets[0];
    const nextAllowedPermissionSets = nextDefault
      ? nextSelectedPermissionSets.filter(
          ({ permissionSetArn }) =>
            permissionSetArn !== nextDefault.permissionSetArn,
        )
      : [];

    clearErrors(["defaultPermissionSet", "allowedPermissionSets"]);
    if (
      nextDefault &&
      nextDefault.permissionSetArn !== defaultPermissionSet?.permissionSetArn
    ) {
      setValue("defaultPermissionSet", nextDefault, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
    updateAllowedPermissionSets(nextAllowedPermissionSets);
  };

  const handleLoadItems = (
    detail: LoadItemsDetail,
    catalog: ReturnType<typeof usePermissionSets>,
    setQuery: (query: string) => void,
    enableCatalog: () => void,
  ) => {
    enableCatalog();

    if (detail.samePage) {
      if (catalog.isLoadingError || catalog.isFetchNextPageError) {
        void catalog.reloadCatalog();
      }
      return;
    }

    if (detail.firstPage) {
      setQuery(boundedQuery(detail.filteringText));
    } else if (catalog.hasNextPage && !catalog.isFetchingNextPage) {
      void catalog.fetchNextPage({ cancelRefetch: false });
    }
  };

  const statusType = (
    catalog: ReturnType<typeof usePermissionSets>,
  ): NonNullable<MultiselectProps["statusType"]> => {
    if (catalog.isLoading || catalog.isFetchingNextPage) {
      return "loading";
    }
    if (catalog.isLoadingError || catalog.isFetchNextPageError) {
      return "error";
    }
    return catalog.hasNextPage ? "pending" : "finished";
  };

  const selectionAtLimit =
    selectedPermissionSets.length >= MAX_ALLOWED_PERMISSION_SETS;
  const permissionSetOptions = [
    ...new Map(
      [
        ...selectedPermissionSets,
        ...bootstrapCatalog.permissionSets,
        ...catalog.permissionSets,
      ].map((permissionSet) => [permissionSet.permissionSetArn, permissionSet]),
    ).values(),
  ].map((permissionSet) => ({
    ...toOption(permissionSet),
    disabled:
      permissionSet.permissionSetArn ===
        defaultPermissionSet?.permissionSetArn ||
      (selectionAtLimit &&
        !selectedPermissionSets.some(
          (selected) =>
            selected.permissionSetArn === permissionSet.permissionSetArn,
        )),
  }));
  const selectedOptions = selectedPermissionSets.map((permissionSet) => ({
    ...toOption(permissionSet),
    disabled:
      permissionSet.permissionSetArn === defaultPermissionSet?.permissionSetArn,
  }));
  const catalogError = bootstrapCatalog.error ?? catalog.error;
  const hasCatalogError =
    bootstrapCatalog.isLoadingError ||
    bootstrapCatalog.isFetchNextPageError ||
    catalog.isLoadingError ||
    catalog.isFetchNextPageError;
  const sharingState = getSharingState(
    leaseSharingEnabled,
    allowOwnerToShareLease,
  );
  const permissionSetsError =
    defaultPermissionSetError?.message ?? allowedPermissionSetsError?.message;

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header
            variant="h2"
            description="Whether lease owners can give other people access to their sandbox account."
          >
            Lease sharing
          </Header>
        }
      >
        <ToggleField
          controllerProps={{ control, name: "allowOwnerToShareLease" }}
          formFieldProps={{
            label: "Allow owner to share lease",
            description: sharingState.description,
          }}
          toggleProps={{
            disabled: disabled || !sharingState.enabled,
            children: allowOwnerToShareLease
              ? "Sharing enabled"
              : "Sharing disabled",
          }}
        />
      </Container>

      <Container
        header={
          <Header
            variant="h2"
            description="Permission sets control what users can do in the sandbox account."
            actions={
              isAdmin ? (
                <Button
                  href="/permission-sets"
                  target="_blank"
                  iconName="external"
                  disabled={disabled}
                >
                  Manage permission sets
                </Button>
              ) : undefined
            }
          >
            Permission sets
          </Header>
        }
      >
        <SpaceBetween size="l">
          {hasCatalogError && (
            <Alert type="error">
              {catalogError instanceof Error
                ? catalogError.message
                : "Permission sets could not be loaded. Try again."}
            </Alert>
          )}

          <FormField
            label="Add permission sets"
            description={
              allowedPermissionSetsDescription ??
              `Select the permission sets available for assignments on leases created from this template. Set the default in the table below. Maximum ${MAX_ALLOWED_PERMISSION_SETS} permission sets.`
            }
            errorText={permissionSetsError}
          >
            <Multiselect
              ref={permissionSetsRef}
              selectedOptions={selectedOptions}
              options={permissionSetOptions}
              placeholder="Search and add permission sets"
              hideTokens
              filteringType="manual"
              onChange={({ detail }) =>
                updateSelectedPermissionSets(detail.selectedOptions)
              }
              onBlur={onPermissionSetsBlur}
              onLoadItems={({ detail }) =>
                handleLoadItems(detail, catalog, setCatalogQuery, () =>
                  setCatalogEnabled(true),
                )
              }
              statusType={statusType(catalog)}
              loadingText="Loading permission sets"
              errorText="Could not load permission sets"
              recoveryText="Reload catalog"
              empty="No registered permission sets"
              finishedText="End of results"
              disabled={disabled}
            />
          </FormField>

          {defaultPermissionSet && (
            <PermissionSetsTable
              header="Selected permission sets"
              defaultPermissionSet={defaultPermissionSet}
              allowedPermissionSets={allowedPermissionSets}
              disabled={disabled}
              onSetDefaultPermissionSet={setDefaultPermissionSet}
              onRemoveAllowedPermissionSet={removeAllowedPermissionSet}
            />
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
