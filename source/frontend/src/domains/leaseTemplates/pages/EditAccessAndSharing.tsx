// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef } from "react";
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
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  useGetLeaseTemplateById,
  useUpdateLeaseTemplate,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import type { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const EditAccessAndSharing = () => {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const query = useGetLeaseTemplateById(uuid);
  const { data: leaseTemplate, isLoading, isError, refetch, error } = query;

  const { mutateAsync: updateLeaseTemplate, isPending: isUpdating } =
    useUpdateLeaseTemplate();
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
    formState: { isDirty, isValid },
  } = methods;
  const initializedTemplateUuid = useRef<string>();

  useEffect(() => {
    if (!leaseTemplate) {
      return;
    }
    if (initializedTemplateUuid.current === uuid && isDirty) {
      return;
    }

    reset({
      allowOwnerToShareLease: leaseTemplate.allowOwnerToShareLease ?? false,
      defaultPermissionSet: leaseTemplate.defaultPermissionSet,
      allowedPermissionSets: withoutDefaultPermissionSet(
        leaseTemplate.defaultPermissionSet,
        leaseTemplate.allowedPermissionSets,
      ),
    });
    initializedTemplateUuid.current = uuid;
  }, [isDirty, leaseTemplate, reset, uuid]);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Lease Templates", href: "/lease_templates" },
      { text: leaseTemplate?.name ?? "...", href: `/lease_templates/${uuid}` },
      { text: "Edit access and sharing", href: "" },
    ]);
    setTools(<Markdown file="edit-lease-template-access-and-sharing" />);
  }, [leaseTemplate, setBreadcrumb, setTools, uuid]);

  const onSubmit = async (values: AccessAndSharingFormValues) => {
    if (!leaseTemplate) {
      return;
    }

    try {
      const updatedLeaseTemplate: LeaseTemplateView = {
        ...leaseTemplate,
        allowOwnerToShareLease: values.allowOwnerToShareLease,
        defaultPermissionSet: values.defaultPermissionSet,
        allowedPermissionSets: values.allowedPermissionSets,
      };

      await updateLeaseTemplate(updatedLeaseTemplate);
      showSuccessToast("Access settings updated successfully.");
      navigate(`/lease_templates/${uuid}`);
    } catch (updateError) {
      const errorMessage =
        updateError instanceof Error
          ? updateError.message
          : "An unexpected error occurred while updating access settings.";
      showErrorToast(
        `Failed to update access settings: ${errorMessage} Please check your inputs and try again.`,
        "Update Failed",
      );
    }
  };

  if (isLoading || isLoadingConfig) {
    return <Loader />;
  }

  if (isError || !leaseTemplate) {
    return (
      <ErrorPanel
        description="There was a problem loading this lease template."
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
          description="Changes apply only to future leases. Existing leases retain the sharing and permission profile settings captured when they were created."
        >
          Edit access and sharing
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
            />

            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  onClick={() => navigate(`/lease_templates/${uuid}`)}
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
