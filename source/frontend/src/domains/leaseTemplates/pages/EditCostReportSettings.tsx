// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Container,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { useNavigate, useParams } from "react-router-dom";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import {
  CostReportSettingsForm,
  CostReportSettingsFormValues,
} from "@amzn/innovation-sandbox-frontend/components/Forms/CostReportSettingsForm";
import { createCostReportSettingsValidationSchema } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  useGetLeaseTemplateById,
  useUpdateLeaseTemplate,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const EditCostReportSettings = () => {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const query = useGetLeaseTemplateById(uuid!);
  const { data: leaseTemplate, isLoading, isError, refetch, error } = query;

  const { mutateAsync: updateLeaseTemplate, isPending: isUpdating } =
    useUpdateLeaseTemplate();

  // Fetch global configuration for validation
  const {
    data: config,
    isLoading: isLoadingConfig,
    isError: isConfigError,
    refetch: refetchConfig,
    error: configError,
  } = useGetConfigurations();
  const requireCostReportGroup = config?.requireCostReportGroup || false;
  const costReportGroups = config?.costReportGroups;

  // Create dynamic schema based on requirements
  const schema = useMemo(
    () => createCostReportSettingsValidationSchema(requireCostReportGroup),
    [requireCostReportGroup],
  );

  // Initialize form with React Hook Form
  const methods = useForm<CostReportSettingsFormValues>({
    resolver: zodResolver(schema),
    mode: "all",
    defaultValues: {
      costReportGroupEnabled: false,
      selectedCostReportGroup: undefined,
    },
  });

  const {
    handleSubmit,
    reset,
    formState: { isValid, isDirty },
  } = methods;

  // Reset form when lease template data loads
  useEffect(() => {
    if (leaseTemplate) {
      reset({
        costReportGroupEnabled: !!leaseTemplate.costReportGroup,
        selectedCostReportGroup: leaseTemplate.costReportGroup,
      });
    }
  }, [leaseTemplate, reset]);

  // Set page breadcrumb on page init
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Lease Templates", href: "/lease_templates" },
      { text: leaseTemplate?.name ?? "...", href: `/lease_templates/${uuid}` },
      { text: "Edit Cost Report Settings", href: "" },
    ]);
    setTools(<Markdown file="edit-lease-template-cost-report" />);
  }, [leaseTemplate, uuid, setBreadcrumb]);

  const onSubmit = async (data: CostReportSettingsFormValues) => {
    if (!leaseTemplate) return;

    try {
      const updatedLeaseTemplate: LeaseTemplate = {
        ...leaseTemplate,
        costReportGroup: data.costReportGroupEnabled
          ? data.selectedCostReportGroup
          : undefined,
      };

      await updateLeaseTemplate(updatedLeaseTemplate);
      showSuccessToast("Cost report settings updated successfully.");
      navigate(`/lease_templates/${uuid}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while updating cost report settings.";
      showErrorToast(
        `Failed to update cost report settings: ${errorMessage} Please check your inputs and try again.`,
        "Update Failed",
      );
    }
  };

  const handleCancel = () => {
    navigate(`/lease_templates/${uuid}`);
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
    <ContentLayout>
      <FormProvider {...methods}>
        <form onSubmit={handleSubmit(onSubmit)}>
          <SpaceBetween size="l">
            <Container
              header={<Header variant="h2">Edit Cost Report Settings</Header>}
            >
              <CostReportSettingsForm
                requireCostReportGroup={requireCostReportGroup}
                costReportGroups={costReportGroups}
              />
            </Container>

            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  onClick={handleCancel}
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
