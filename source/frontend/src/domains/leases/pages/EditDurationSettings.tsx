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
  ExpirationSettingsForm,
  ExpirationSettingsFormValues,
} from "@amzn/innovation-sandbox-frontend/components/Forms/ExpirationSettingsForm";
import { createLeaseExpirationValidationSchema } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
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

export const EditDurationSettings = () => {
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
  const globalMaxDurationHours = config?.leases.maxDurationHours;
  const requireMaxDuration = config?.leases.requireMaxDuration || false;

  // Get lease start date for duration validation (as ISO string)
  const leaseStartDate = useMemo(() => {
    return lease?.startDate || undefined;
  }, [lease?.startDate]);

  // Create dynamic schema based on requirements
  const schema = useMemo(
    () =>
      createLeaseExpirationValidationSchema(
        requireMaxDuration,
        globalMaxDurationHours,
        leaseStartDate,
      ),
    [requireMaxDuration, globalMaxDurationHours, leaseStartDate],
  );

  // Initialize form with React Hook Form
  const methods = useForm<ExpirationSettingsFormValues>({
    resolver: zodResolver(schema),
    mode: "all",
    defaultValues: {
      maxDurationEnabled: false,
      expirationDate: undefined,
      durationThresholds: [],
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
        maxDurationEnabled: !!lease.expirationDate,
        expirationDate: lease.expirationDate,
        durationThresholds: lease.durationThresholds,
      });
    }
  }, [lease, reset]);

  // Set page breadcrumb on page init
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Leases", href: "/leases" },
      { text: lease?.userEmail ?? "...", href: `/leases/${leaseId}` },
      { text: "Edit Duration Settings", href: "" },
    ]);
    setTools(<Markdown file="edit-lease-duration" />);
  }, [lease, leaseId, setBreadcrumb]);

  const onSubmit = async (data: ExpirationSettingsFormValues) => {
    if (!lease) return;

    try {
      const leasePatchRequest: LeasePatchRequest = {
        leaseId: lease.leaseId,
        durationThresholds: data.maxDurationEnabled
          ? data.durationThresholds
          : [],
        expirationDate: data.maxDurationEnabled
          ? data.expirationDate || null
          : null,
      };

      await updateLease(leasePatchRequest);
      showSuccessToast("Duration settings updated successfully.");
      navigate(`/leases/${leaseId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while updating duration settings.";
      showErrorToast(
        `Failed to update duration settings: ${errorMessage}`,
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
              header={<Header variant="h2">Edit Duration Settings</Header>}
            >
              <ExpirationSettingsForm requireMaxDuration={requireMaxDuration} />
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
