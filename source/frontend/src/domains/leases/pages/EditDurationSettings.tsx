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
import { getLeaseDisplayName } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
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

  const query = useGetLeaseById(leaseId);
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

  // Lifecycle dates are absent from pending and denied lease views.
  const leaseStartDate = useMemo(
    () => (lease && "startDate" in lease ? lease.startDate : undefined),
    [lease],
  );

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
      // Expiration dates are absent from pending and denied lease views.
      const expirationDate =
        "expirationDate" in lease ? lease.expirationDate : undefined;
      reset({
        maxDurationEnabled: !!expirationDate,
        expirationDate,
        durationThresholds: lease.durationThresholds ?? [],
      });
    }
  }, [lease, reset]);

  // Set page breadcrumb on page init
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Leases", href: "/leases" },
      {
        text: lease ? getLeaseDisplayName(lease) : "...",
        href: `/leases/${leaseId}`,
      },
      { text: "Edit Duration Settings", href: "" },
    ]);
    setTools(<Markdown file="edit-lease-duration" />);
  }, [lease, leaseId, setBreadcrumb]);

  const onSubmit = async (data: ExpirationSettingsFormValues) => {
    if (!lease) return;

    try {
      // When a duration is required, the enable toggle is disabled (forced on)
      // in the form, so `maxDurationEnabled` stays false even though the user
      // set a date. Treat "required" as enabled so the value is sent, not
      // dropped.
      const durationEnabled = data.maxDurationEnabled || requireMaxDuration;
      const leasePatchRequest: LeasePatchRequest = {
        leaseId: lease.leaseId,
        durationThresholds: durationEnabled ? data.durationThresholds : [],
        expirationDate: durationEnabled ? data.expirationDate || null : null,
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
              <ExpirationSettingsForm
                requireMaxDuration={requireMaxDuration}
                predictiveBudgetEnabled={lease.predictiveBudgetEnabled ?? false}
                leaseStartDate={leaseStartDate}
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
