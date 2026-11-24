// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
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
  BudgetSettingsForm,
  BudgetSettingsFormValues,
  parseRateLimitFormRows,
  stripTriggerOn,
} from "@amzn/innovation-sandbox-frontend/components/Forms/BudgetSettingsForm";
import { hoursBetween } from "@amzn/innovation-sandbox-frontend/components/Forms/PredictiveDurationWarning";
import { createBudgetSettingsValidationSchema } from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
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

export const EditBudgetSettings = () => {
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
  const globalMaxBudget = config?.leases.maxBudget;
  const requireMaxBudget = config?.leases.requireMaxBudget || false;
  const allowPredictiveBudgetControls =
    config?.leases.allowPredictiveBudgetControls || false;
  const allowBedrockTokenMonitoring =
    config?.leases.allowBedrockTokenMonitoring || false;
  // Create dynamic schema based on requirements
  const schema = useMemo(
    () =>
      createBudgetSettingsValidationSchema(globalMaxBudget, requireMaxBudget),
    [globalMaxBudget, requireMaxBudget],
  );

  // Initialize form with React Hook Form
  const methods = useForm<BudgetSettingsFormValues>({
    resolver: zodResolver(schema),
    mode: "all",
    defaultValues: {
      maxBudgetEnabled: false,
      maxSpend: undefined,
      budgetThresholds: [],
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
    },
  });

  const {
    handleSubmit,
    reset,
    trigger,
    formState: { isValid, isDirty },
  } = methods;

  // Reset form when lease data loads
  useEffect(() => {
    if (lease) {
      reset({
        maxBudgetEnabled:
          lease.maxSpend !== undefined && lease.maxSpend !== null,
        maxSpend: lease.maxSpend,
        // The trigger-on selectors register `triggerOn` on mount, so it is
        // seeded here too: a key only the live values carried would mark the
        // form dirty after predictive controls are switched off and on.
        budgetThresholds: (lease.budgetThresholds || []).map((threshold) => ({
          ...threshold,
          triggerOn: threshold.triggerOn,
        })),
        rateLimits: lease.rateLimits ?? [],
        predictiveBudgetEnabled: lease.predictiveBudgetEnabled ?? false,
        bedrockTokenMonitoringEnabled:
          lease.bedrockTokenMonitoringEnabled ?? false,
      });
    }
  }, [lease, reset]);

  useEffect(() => {
    if (lease && config) {
      trigger();
    }
  }, [lease, config, schema, trigger]);

  // Set page breadcrumb on page init
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Leases", href: "/leases" },
      {
        text: lease ? getLeaseDisplayName(lease) : "...",
        href: `/leases/${leaseId}`,
      },
      { text: "Edit Budget Settings", href: "" },
    ]);
    setTools(<Markdown file="edit-lease-budget" />);
  }, [lease, leaseId, setBreadcrumb]);

  const onSubmit = async (data: BudgetSettingsFormValues) => {
    if (!lease) return;

    try {
      // When a budget is required, the enable toggle is disabled (forced on) in
      // the form, so `maxBudgetEnabled` stays false even though the user entered
      // a value. Treat "required" as enabled so the value is sent, not dropped.
      const budgetEnabled = data.maxBudgetEnabled || requireMaxBudget;
      const predictiveBudgetEnabled = data.predictiveBudgetEnabled ?? false;
      const leasePatchRequest: LeasePatchRequest = {
        leaseId: lease.leaseId,
        budgetThresholds: predictiveBudgetEnabled
          ? data.budgetThresholds
          : stripTriggerOn(data.budgetThresholds),
        maxSpend: budgetEnabled ? data.maxSpend : null,
        predictiveBudgetEnabled,
        bedrockTokenMonitoringEnabled:
          data.bedrockTokenMonitoringEnabled ?? false,
        // Omitted while predictive controls are off, which clears the stored
        // limits.
        ...(predictiveBudgetEnabled && {
          // null clears; undefined would be dropped from the JSON body and
          // leave the old value in place.
          rateLimits: parseRateLimitFormRows(data.rateLimits) ?? null,
        }),
      };

      await updateLease(leasePatchRequest);
      showSuccessToast("Budget settings updated successfully.");
      navigate(`/leases/${leaseId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while updating budget settings.";
      showErrorToast(
        `Failed to update budget settings: ${errorMessage}`,
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
    <ContentLayout
      header={
        <Header
          variant="h1"
          info={<InfoLink markdown="edit-lease-budget" />}
          description="Spending limit, thresholds and rate thresholds"
        >
          Edit Budget Settings
        </Header>
      }
    >
      <FormProvider {...methods}>
        <form onSubmit={handleSubmit(onSubmit)}>
          <SpaceBetween size="l">
            <BudgetSettingsForm
              globalMaxBudget={globalMaxBudget}
              requireMaxBudget={requireMaxBudget}
              variant="lease"
              allowPredictiveBudgetControls={allowPredictiveBudgetControls}
              persistedPredictiveBudgetEnabled={
                lease.predictiveBudgetEnabled ?? false
              }
              allowBedrockTokenMonitoring={allowBedrockTokenMonitoring}
              sandboxSpacesEnabled={lease.sandboxSpacesEnabled === true}
              persistedBedrockTokenMonitoringEnabled={
                lease.bedrockTokenMonitoringEnabled ?? false
              }
              leaseDurationInHours={
                "startDate" in lease
                  ? hoursBetween(lease.startDate, lease.expirationDate)
                  : undefined
              }
            />

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
