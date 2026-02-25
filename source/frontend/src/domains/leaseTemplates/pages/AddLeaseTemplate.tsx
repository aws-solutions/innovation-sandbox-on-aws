// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Container,
  Header,
  Wizard,
  WizardProps,
} from "@cloudscape-design/components";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import {
  BudgetSettingsForm,
  BudgetSettingsFormValues,
} from "@amzn/innovation-sandbox-frontend/components/Forms/BudgetSettingsForm";
import {
  CostReportSettingsForm,
  CostReportSettingsFormValues,
} from "@amzn/innovation-sandbox-frontend/components/Forms/CostReportSettingsForm";
import {
  DurationSettingsForm,
  DurationSettingsFormValues,
} from "@amzn/innovation-sandbox-frontend/components/Forms/DurationSettingsForm";
import {
  type BlueprintSelectionFormValues,
  SelectBlueprintForm,
} from "@amzn/innovation-sandbox-frontend/components/Forms/SelectBlueprintForm";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  BasicDetailsForm,
  type BasicDetailsFormValues,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/BasicDetailsForm";
import { LeaseTemplateSummary } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/LeaseTemplateSummary";
import { useAddLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { NewLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/types";
import { createLeaseTemplateWizardValidationSchema } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

type LeaseTemplateFormValues = BasicDetailsFormValues &
  BudgetSettingsFormValues &
  DurationSettingsFormValues &
  CostReportSettingsFormValues &
  BlueprintSelectionFormValues;

export const AddLeaseTemplate = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Lease Templates", href: "/lease_templates" },
      { text: "Add a New Lease Template", href: "/lease_templates/new" },
    ]);
    setTools(<Markdown file="add-lease-template" />);
  }, [setBreadcrumb]);

  const { mutateAsync: addLeaseTemplate, isPending: isSaving } =
    useAddLeaseTemplate();

  const {
    data: config,
    isError: isConfigError,
    refetch: refetchConfig,
    error: configError,
  } = useGetConfigurations();
  const globalMaxBudget = config?.leases.maxBudget;
  const requireMaxBudget = config?.leases.requireMaxBudget || false;
  const requireCostReportGroup = config?.requireCostReportGroup || false;
  const costReportGroups = config?.costReportGroups;
  const globalMaxDurationHours = config?.leases.maxDurationHours;
  const requireMaxDuration = config?.leases.requireMaxDuration || false;

  // Create combined validation schema
  const validationSchema = useMemo(
    () =>
      createLeaseTemplateWizardValidationSchema({
        globalMaxBudget: globalMaxBudget,
        requireMaxBudget: requireMaxBudget,
        globalMaxDurationHours: globalMaxDurationHours,
        requireMaxDuration: requireMaxDuration,
        requireCostReportGroup: requireCostReportGroup,
      }),
    [config],
  );

  // Single useForm instance for the entire wizard
  const methods = useForm<LeaseTemplateFormValues>({
    resolver: zodResolver(validationSchema),
    mode: "all",
    defaultValues: {
      // Basic Details
      name: "",
      description: "",
      requiresApproval: true,
      visibility: "PRIVATE",
      // Budget Settings
      maxBudgetEnabled: true,
      maxSpend: undefined,
      budgetThresholds: [],
      // Duration Settings
      maxDurationEnabled: true,
      leaseDurationInHours: undefined,
      durationThresholds: [],
      // Cost Report Settings
      costReportGroupEnabled: config?.requireCostReportGroup ?? false,
      selectedCostReportGroup: undefined,
      blueprintEnabled: true,
      blueprintId: undefined,
      blueprintName: undefined,
    },
  });

  const { trigger, clearErrors, getFieldState } = methods;

  // Track active wizard step
  const [activeStepIndex, setActiveStepIndex] = useState(0);

  const handleNavigate = async ({
    detail,
  }: {
    detail: WizardProps.NavigateDetail;
  }) => {
    await trigger();

    const { requestedStepIndex } = detail;

    // Only validate when moving forward
    if (requestedStepIndex > activeStepIndex) {
      // Check if current step has errors
      const stepFields: Array<Array<keyof LeaseTemplateFormValues>> = [
        ["name", "description", "requiresApproval", "visibility"],
        ["blueprintId"],
        ["maxBudgetEnabled", "maxSpend", "budgetThresholds"],
        ["maxDurationEnabled", "leaseDurationInHours", "durationThresholds"],
        ["costReportGroupEnabled", "selectedCostReportGroup"],
        [], // Review step has no fields to validate
      ];

      const currentStepFields = stepFields[activeStepIndex];
      const currentStepHasErrors = currentStepFields.some(
        (field) => getFieldState(field).error !== undefined,
      );

      if (currentStepHasErrors) {
        // Don't allow navigation if current step has errors
        return;
      }
    }
    clearErrors(); // clear errors so that the page being navigated to is fresh
    setActiveStepIndex(requestedStepIndex);
  };

  const handleSubmit = async () => {
    const isValid = await trigger();
    if (!isValid) {
      showErrorToast(
        "Please correct the validation errors in the form before submitting. Check all required fields and ensure values meet the specified requirements.",
        "Validation Failed",
      );
      return;
    }

    try {
      // Get form values
      const values = methods.getValues();

      const leaseTemplate: NewLeaseTemplate = {
        name: values.name,
        description: values.description,
        requiresApproval: values.requiresApproval,
        visibility: values.visibility,
        maxSpend: values.maxSpend,
        budgetThresholds: values.budgetThresholds,
        leaseDurationInHours: values.leaseDurationInHours,
        durationThresholds: values.durationThresholds,
        costReportGroup: values.selectedCostReportGroup,
        blueprintId: values.blueprintId,
      };

      await addLeaseTemplate(leaseTemplate);
      showSuccessToast("New lease template added successfully.");
      navigate("/lease_templates");
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while creating the lease template.";
      showErrorToast(
        `Failed to create lease template: ${errorMessage} Please check your inputs and try again.`,
        "Creation Failed",
      );
    }
  };

  const handleCancel = () => {
    navigate("/lease_templates");
  };

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
    <FormProvider {...methods}>
      <ContentLayout
        header={
          <Header variant="h1" description="Create a new lease template">
            Add Lease Template
          </Header>
        }
      >
        <Wizard
          i18nStrings={{
            stepNumberLabel: (stepNumber: number) => `Step ${stepNumber}`,
            collapsedStepsLabel: (stepNumber: number, stepsCount: number) =>
              `Step ${stepNumber} of ${stepsCount}`,
            skipToButtonLabel: (step: WizardProps.Step) =>
              `Skip to ${step.title}`,
            navigationAriaLabel: "Steps",
            cancelButton: "Cancel",
            previousButton: "Previous",
            nextButton: "Next",
            optional: "optional",
          }}
          submitButtonText="Create lease template"
          onNavigate={handleNavigate}
          onCancel={handleCancel}
          onSubmit={handleSubmit}
          activeStepIndex={activeStepIndex}
          allowSkipTo
          isLoadingNextStep={isSaving}
          steps={[
            {
              title: "Basic Details",
              content: (
                <Container>
                  <BasicDetailsForm />
                </Container>
              ),
              description: "Basic information",
              isOptional: false,
            },
            {
              title: "Blueprint",
              content: (
                <Container>
                  <SelectBlueprintForm />
                </Container>
              ),
              description: "Select a blueprint",
              isOptional: false,
            },
            {
              title: "Budget",
              content: (
                <Container>
                  <BudgetSettingsForm
                    requireMaxBudget={requireMaxBudget}
                    globalMaxBudget={globalMaxBudget}
                  />
                </Container>
              ),
              description: "Budget limits and thresholds",
              isOptional: false,
            },
            {
              title: "Lease Duration",
              content: (
                <Container>
                  <DurationSettingsForm
                    requireMaxDuration={requireMaxDuration}
                    globalMaxDurationHours={globalMaxDurationHours}
                  />
                </Container>
              ),
              description: "Time limits and duration thresholds",
              isOptional: false,
            },
            {
              title: "Cost Report",
              content: (
                <Container>
                  <CostReportSettingsForm
                    requireCostReportGroup={requireCostReportGroup}
                    costReportGroups={costReportGroups}
                  />
                </Container>
              ),
              description: "Cost allocation and reporting",
              isOptional: false,
            },
            {
              title: "Review and Submit",
              content: (
                <LeaseTemplateSummary
                  leaseTemplate={{
                    name: methods.watch("name"),
                    description: methods.watch("description"),
                    requiresApproval: methods.watch("requiresApproval"),
                    visibility: methods.watch("visibility"),
                    maxSpend: methods.watch("maxSpend"),
                    budgetThresholds: methods.watch("budgetThresholds"),
                    leaseDurationInHours: methods.watch("leaseDurationInHours"),
                    durationThresholds: methods.watch("durationThresholds"),
                    costReportGroup: methods.watch("selectedCostReportGroup"),
                    blueprintId: methods.watch("blueprintId"),
                    blueprintName: methods.watch("blueprintName"),
                  }}
                  showEditButtons={false}
                />
              ),
              description: "Review your lease template configuration",
              isOptional: false,
            },
          ]}
        />
      </ContentLayout>
    </FormProvider>
  );
};
