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
  useGetLeaseById,
  useUpdateLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { LeasePatchRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const EditCostReportSettings = () => {
  const { leaseId } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const query = useGetLeaseById(leaseId!);
  const { data: lease, isLoading, isError, refetch, error } = query;

  const { mutateAsync: updateLease, isPending: isUpdating } = useUpdateLease();

  // Fetch global configuration for validation and form props
  const {
    data: config,
    isLoading: isLoadingConfig,
    isError: isConfigError,
    refetch: refetchConfig,
    error: configError,
  } = useGetConfigurations();
  const costReportGroups = config?.costReportGroups ?? [];
  const requireCostReportGroup = config?.requireCostReportGroup || false;

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

  // Reset form when lease data loads
  useEffect(() => {
    if (lease) {
      reset({
        costReportGroupEnabled: !!lease.costReportGroup,
        selectedCostReportGroup: lease.costReportGroup,
      });
    }
  }, [lease, reset]);

  // Set page breadcrumb on page init
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Leases", href: "/leases" },
      { text: lease?.userEmail ?? "...", href: `/leases/${leaseId}` },
      { text: "Edit Cost Report Settings", href: "" },
    ]);
    setTools(<Markdown file="edit-lease-cost-report" />);
  }, [lease, leaseId, setBreadcrumb]);

  const onSubmit = async (data: CostReportSettingsFormValues) => {
    if (!lease) return;

    try {
      const leasePatchRequest: LeasePatchRequest = {
        leaseId: lease.leaseId,
        costReportGroup: data.costReportGroupEnabled
          ? data.selectedCostReportGroup
          : null,
      };

      await updateLease(leasePatchRequest);
      showSuccessToast("Cost report settings updated successfully.");
      navigate(`/leases/${leaseId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while updating cost report settings.";
      showErrorToast(
        `Failed to update cost report settings: ${errorMessage}`,
        "Update Failed",
      );
    }
  };

  const handleCancel = () => {
    navigate(`/leases/${leaseId}`);
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
    <ContentLayout>
      <FormProvider {...methods}>
        <form onSubmit={handleSubmit(onSubmit)}>
          <SpaceBetween size="l">
            <Container
              header={<Header variant="h2">Edit Cost Report Settings</Header>}
            >
              <CostReportSettingsForm
                costReportGroups={costReportGroups}
                requireCostReportGroup={requireCostReportGroup}
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
