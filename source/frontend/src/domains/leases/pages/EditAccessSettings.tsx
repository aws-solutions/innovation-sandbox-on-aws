// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { zodResolver } from "@hookform/resolvers/zod";
import { type ReactNode, useEffect, useRef } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { useNavigate, useParams } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import {
  AccessAndSharingForm,
  type AccessAndSharingFormValues,
} from "@amzn/innovation-sandbox-frontend/components/Forms/AccessAndSharingForm";
import { AccessAndSharingValidationSchema } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { withoutDefaultPermissionSet } from "@amzn/innovation-sandbox-frontend/components/PermissionSetsTable";
import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  getLeaseAssignmentsPath,
  getLeaseDisplayName,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  useGetLeaseById,
  useUpdateLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import type { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import type { LeasePatchRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { MAX_ALLOWED_PERMISSION_SETS } from "@amzn/innovation-sandbox-shared/types/permission-set";

function permissionProfileConflictMessage(
  lease: LeaseView,
  values: AccessAndSharingFormValues,
  error: ApiError,
): ReactNode {
  const nextAllowedArns = new Set(
    values.allowedPermissionSets.map(
      ({ permissionSetArn }) => permissionSetArn,
    ),
  );
  nextAllowedArns.add(values.defaultPermissionSet.permissionSetArn);

  const previousDefaultArn = lease.defaultPermissionSet?.permissionSetArn;
  const conflictingAssignments =
    lease.desiredAssignments?.filter((assignment) => {
      const effectiveArn = assignment.permissionSetArn ?? previousDefaultArn;
      return effectiveArn !== undefined && !nextAllowedArns.has(effectiveArn);
    }) ?? [];
  const firstConflictingAssignment = conflictingAssignments[0];
  const conflictingArn =
    firstConflictingAssignment?.permissionSetArn ?? previousDefaultArn;
  const conflictingAssignmentCount = conflictingAssignments.filter(
    (assignment) =>
      (assignment.permissionSetArn ?? previousDefaultArn) === conflictingArn,
  ).length;
  const conflictingPermissionSet = [
    ...(lease.defaultPermissionSet ? [lease.defaultPermissionSet] : []),
    ...(lease.allowedPermissionSets ?? []),
  ].find(({ permissionSetArn }) => permissionSetArn === conflictingArn);
  const leaseName = getLeaseDisplayName(lease);
  const assignmentsPath = getLeaseAssignmentsPath(lease.leaseId);

  if (conflictingAssignmentCount > 0) {
    const permissionSet =
      conflictingPermissionSet?.name ??
      conflictingPermissionSet?.permissionSetArn ??
      conflictingArn ??
      "a removed permission set";
    const assignmentLabel =
      conflictingAssignmentCount === 1 ? "assignment" : "assignments";
    const verb = conflictingAssignmentCount === 1 ? "is" : "are";
    return (
      <>
        <strong>{conflictingAssignmentCount}</strong> {assignmentLabel} using{" "}
        <strong>{permissionSet}</strong> {verb} still active on{" "}
        <strong>{leaseName}</strong>.{" "}
        <TextLink to={assignmentsPath}>Open assignments</TextLink> to update{" "}
        {conflictingAssignmentCount === 1 ? "it" : "them"}, then try again.
      </>
    );
  }

  return (
    <>
      {error.message}{" "}
      <TextLink to={assignmentsPath}>Open assignments for {leaseName}</TextLink>{" "}
      and update any assignment using the removed permission set, then try
      again.
    </>
  );
}

function accessSettingsErrorMessage(
  lease: LeaseView,
  values: AccessAndSharingFormValues,
  updateError: unknown,
): ReactNode {
  if (
    updateError instanceof ApiError &&
    updateError.statusCode === 409 &&
    (updateError.message.includes("still used by a desired assignment") ||
      updateError.message.includes("still used by the legacy owner assignment"))
  ) {
    return permissionProfileConflictMessage(lease, values, updateError);
  }

  if (updateError instanceof Error) {
    return updateError.message;
  }

  return "An unexpected error occurred while updating access settings.";
}

export const EditAccessSettings = () => {
  const { leaseId } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const query = useGetLeaseById(leaseId);
  const { data: lease, isLoading, isError, refetch, error } = query;
  const { mutateAsync: updateLease, isPending: isUpdating } = useUpdateLease();
  const {
    data: config,
    isLoading: isLoadingConfig,
    isError: isConfigError,
    refetch: refetchConfig,
    error: configError,
  } = useGetConfigurations();
  const leaseSharingEnabled = config?.leases.leaseSharingEnabled ?? false;

  const methods = useForm<AccessAndSharingFormValues>({
    resolver: zodResolver(AccessAndSharingValidationSchema),
    mode: "all",
    defaultValues: {
      allowOwnerToShareLease: false,
      defaultPermissionSet: undefined,
      allowedPermissionSets: [],
    },
  });
  const {
    handleSubmit,
    reset,
    formState: { dirtyFields, isDirty, isValid },
  } = methods;
  const initializedLeaseId = useRef<string>();

  useEffect(() => {
    if (!lease) {
      return;
    }
    if (initializedLeaseId.current === leaseId && isDirty) {
      return;
    }

    reset({
      allowOwnerToShareLease: lease.allowOwnerToShareLease ?? false,
      defaultPermissionSet: lease.defaultPermissionSet,
      allowedPermissionSets: withoutDefaultPermissionSet(
        lease.defaultPermissionSet,
        lease.allowedPermissionSets,
      ),
    });
    initializedLeaseId.current = leaseId;
  }, [isDirty, lease, leaseId, reset]);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Leases", href: "/leases" },
      {
        text: lease ? getLeaseDisplayName(lease) : "...",
        href: `/leases/${leaseId}`,
      },
      { text: "Edit Access Settings", href: "" },
    ]);
    setTools(<Markdown file="edit-access-settings" />);
  }, [lease, leaseId, setBreadcrumb, setTools]);

  const onSubmit = async (values: AccessAndSharingFormValues) => {
    if (!lease) {
      return;
    }

    const request: LeasePatchRequest = {
      leaseId: lease.leaseId,
      ...(dirtyFields.allowOwnerToShareLease && {
        allowOwnerToShareLease: values.allowOwnerToShareLease,
      }),
      ...(dirtyFields.defaultPermissionSet && {
        defaultPermissionSet: values.defaultPermissionSet,
      }),
      ...((dirtyFields.allowedPermissionSets ||
        dirtyFields.defaultPermissionSet) && {
        allowedPermissionSets: values.allowedPermissionSets,
      }),
    };

    try {
      await updateLease(request);
      showSuccessToast("Access settings updated successfully.");
      navigate(`/leases/${leaseId}`);
    } catch (updateError) {
      const errorMessage = accessSettingsErrorMessage(
        lease,
        values,
        updateError,
      );
      showErrorToast(
        typeof errorMessage === "string" ? (
          `Failed to update access settings: ${errorMessage}`
        ) : (
          <>Failed to update access settings: {errorMessage}</>
        ),
        "Update Failed",
      );
    }
  };

  if (isLoading || isLoadingConfig) {
    return <Loader />;
  }

  if (isError || !lease) {
    return (
      <ErrorPanel
        description="There was a problem loading this lease."
        retry={refetch}
        error={error as Error}
      />
    );
  }

  if (isConfigError || !config) {
    return (
      <ErrorPanel
        description="There was a problem loading configuration settings."
        retry={refetchConfig}
        error={configError as Error}
      />
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Changes apply to sharing and permission-set assignments for this lease."
        >
          Edit Access Settings
        </Header>
      }
    >
      <FormProvider {...methods}>
        <form onSubmit={handleSubmit(onSubmit)}>
          <SpaceBetween size="l">
            <AccessAndSharingForm
              bootstrapBuiltInDefault={false}
              disabled={isUpdating}
              leaseSharingEnabled={leaseSharingEnabled}
              allowedPermissionSetsDescription={`Select the permission sets available for assignments on this lease. Set the default in the table below. Maximum ${MAX_ALLOWED_PERMISSION_SETS} permission sets.`}
            />

            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  onClick={() => navigate(`/leases/${leaseId}`)}
                  formAction="none"
                  disabled={isUpdating}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  formAction="submit"
                  loading={isUpdating}
                  disabled={!isValid || !isDirty || isUpdating}
                >
                  Save changes
                </Button>
              </SpaceBetween>
            </Box>
          </SpaceBetween>
        </form>
      </FormProvider>
    </ContentLayout>
  );
};
