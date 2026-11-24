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
  AccessAndSharingForm,
  type AccessAndSharingFormValues,
} from "@amzn/innovation-sandbox-frontend/components/Forms/AccessAndSharingForm";
import {
  BudgetSettingsForm,
  BudgetSettingsFormValues,
  stripTriggerOn,
  toTemplateBudgetFields,
  tryParseRateLimitFormRows,
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
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
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
import {
  SandboxSpacesForm,
  type SandboxSpacesFormValues,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/SandboxSpacesForm";
import {
  useAddLeaseTemplate,
  useEnabledModelIds,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { CreateLeaseTemplateRequest } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/types";
import { createLeaseTemplateWizardValidationSchema } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

type LeaseTemplateFormValues = BasicDetailsFormValues &
  BudgetSettingsFormValues &
  DurationSettingsFormValues &
  CostReportSettingsFormValues &
  BlueprintSelectionFormValues &
  SandboxSpacesFormValues &
  AccessAndSharingFormValues;

function costReportGroupToSave(
  {
    costReportGroupEnabled,
    selectedCostReportGroup,
  }: CostReportSettingsFormValues,
  requireCostReportGroup: boolean,
): string | undefined {
  if (costReportGroupEnabled || requireCostReportGroup) {
    return selectedCostReportGroup;
  }
  return undefined;
}

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
  }, [setBreadcrumb, setTools]);

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
  const requireCostReportGroup =
    config?.costReporting.requireCostReportGroup || false;
  const costReportGroups = config?.costReporting.costReportGroups;
  const globalMaxDurationHours = config?.leases.maxDurationHours;
  const requireMaxDuration = config?.leases.requireMaxDuration || false;
  const leaseSharingEnabled = config?.leases.leaseSharingEnabled || false;
  const sandboxSpacesEnabled = config?.agent.sandboxSpacesEnabled || false;
  const allowPredictiveBudgetControls =
    config?.leases.allowPredictiveBudgetControls || false;
  const allowBedrockTokenMonitoring =
    config?.leases.allowBedrockTokenMonitoring || false;
  const enabledModelIds = useEnabledModelIds(
    config?.agent.sandboxSpacesEnabled,
  );

  // Create combined validation schema
  const validationSchema = useMemo(
    () =>
      createLeaseTemplateWizardValidationSchema({
        globalMaxBudget: globalMaxBudget,
        requireMaxBudget: requireMaxBudget,
        globalMaxDurationHours: globalMaxDurationHours,
        requireMaxDuration: requireMaxDuration,
        requireCostReportGroup: requireCostReportGroup,
        enabledModelIds,
      }),
    [
      globalMaxBudget,
      requireMaxBudget,
      globalMaxDurationHours,
      requireMaxDuration,
      requireCostReportGroup,
      enabledModelIds,
    ],
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
      allowOwnerToShareLease: false,
      // Budget Settings
      maxBudgetEnabled: true,
      maxSpend: undefined,
      budgetThresholds: [],
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
      rateLimits: [],
      // Duration Settings
      maxDurationEnabled: true,
      leaseDurationInHours: undefined,
      durationThresholds: [],
      // Cost Report Settings
      costReportGroupEnabled:
        config?.costReporting.requireCostReportGroup ?? false,
      selectedCostReportGroup: undefined,
      blueprintEnabled: true,
      blueprintId: undefined,
      blueprintName: undefined,
      // Sandbox Spaces
      sandboxSpacesEnabled: false,
      allowedModelIds: [],
      defaultModelId: undefined,
      limitModels: false,
      // Access settings
      defaultPermissionSet: undefined,
      allowedPermissionSets: [],
    },
  });

  const { trigger, clearErrors, getFieldState } = methods;

  // Track active wizard step
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [sandboxSpacesTurnedOff, setSandboxSpacesTurnedOff] = useState(false);

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
        [
          "allowOwnerToShareLease",
          "defaultPermissionSet",
          "allowedPermissionSets",
        ],
        [
          "sandboxSpacesEnabled",
          "allowedModelIds",
          "defaultModelId",
          "limitModels",
        ],
        [
          "maxBudgetEnabled",
          "maxSpend",
          "budgetThresholds",
          "predictiveBudgetEnabled",
          "bedrockTokenMonitoringEnabled",
          "rateLimits",
        ],
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

      const leaseTemplate: CreateLeaseTemplateRequest = {
        name: values.name,
        description: values.description,
        requiresApproval: values.requiresApproval,
        visibility: values.visibility,
        maxSpend: values.maxSpend,
        ...toTemplateBudgetFields(values),
        leaseDurationInHours: values.leaseDurationInHours,
        durationThresholds: values.durationThresholds,
        costReportGroup: costReportGroupToSave(values, requireCostReportGroup),
        blueprintId: values.blueprintId ?? undefined,
        allowOwnerToShareLease: values.allowOwnerToShareLease,
        sandboxSpacesEnabled: values.sandboxSpacesEnabled,
        // Only persist a model subset when Sandbox Spaces is on; empty/undefined
        // inherits the globally enabled set.
        allowedModelIds:
          values.sandboxSpacesEnabled && values.allowedModelIds.length > 0
            ? values.allowedModelIds
            : undefined,
        // Persisted as part of the shared contract. The Sandbox Spaces step only
        // lets a default be chosen from the selected models, so it is sent only
        // when Sandbox Spaces is on.
        defaultModelId: values.sandboxSpacesEnabled
          ? values.defaultModelId
          : undefined,
        defaultPermissionSetArn: values.defaultPermissionSet.permissionSetArn,
        allowedPermissionSetArns: values.allowedPermissionSets.map(
          (permissionSet) => permissionSet.permissionSetArn,
        ),
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
              title: "Basic details",
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
              content: <SelectBlueprintForm />,
              description: "Resources deployed with the lease",
              isOptional: false,
            },
            {
              title: "Access and sharing",
              content: (
                <AccessAndSharingForm
                  leaseSharingEnabled={leaseSharingEnabled}
                />
              ),
              description:
                "Configure lease sharing and the permission sets available for assignments",
              isOptional: false,
            },
            {
              title: "Sandbox Space",
              content: (
                <SandboxSpacesForm
                  sandboxSpacesSetting={config?.agent.sandboxSpacesEnabled}
                  variant="template"
                  monitoring={{
                    allowBedrockTokenMonitoring,
                    sandboxSpacesTurnedOff,
                    onSandboxSpacesTurnedOff: () =>
                      setSandboxSpacesTurnedOff(true),
                  }}
                />
              ),
              description: "AI chat access and estimated token cost",
              isOptional: false,
            },
            {
              title: "Budget",
              info: <InfoLink markdown="add-lease-template" />,
              content: (
                <BudgetSettingsForm
                  requireMaxBudget={requireMaxBudget}
                  globalMaxBudget={globalMaxBudget}
                  variant="template"
                  allowPredictiveBudgetControls={allowPredictiveBudgetControls}
                  allowBedrockTokenMonitoring={allowBedrockTokenMonitoring}
                  sandboxSpacesEnabled={methods.watch("sandboxSpacesEnabled")}
                  leaseDurationInHours={
                    methods.watch("maxDurationEnabled") || requireMaxDuration
                      ? methods.watch("leaseDurationInHours")
                      : undefined
                  }
                />
              ),
              description: "Spending limit, thresholds and rate thresholds",
              isOptional: false,
            },
            {
              title: "Duration",
              content: (
                <Container>
                  <DurationSettingsForm
                    requireMaxDuration={requireMaxDuration}
                    globalMaxDurationHours={globalMaxDurationHours}
                    predictiveBudgetEnabled={methods.watch(
                      "predictiveBudgetEnabled",
                    )}
                  />
                </Container>
              ),
              description: "Time limits and duration thresholds",
              isOptional: false,
            },
            {
              title: "Cost reporting",
              content: (
                <Container>
                  <CostReportSettingsForm
                    requireCostReportGroup={requireCostReportGroup}
                    costReportGroups={costReportGroups}
                    variant="template"
                  />
                </Container>
              ),
              description: "Cost allocation and reporting",
              isOptional: false,
            },
            {
              title: "Review and submit",
              content: (
                <LeaseTemplateSummary
                  leaseTemplate={{
                    name: methods.watch("name"),
                    description: methods.watch("description"),
                    requiresApproval: methods.watch("requiresApproval"),
                    visibility: methods.watch("visibility"),
                    maxSpend: methods.watch("maxSpend"),
                    budgetThresholds: methods.watch("predictiveBudgetEnabled")
                      ? methods.watch("budgetThresholds")
                      : stripTriggerOn(methods.watch("budgetThresholds")),
                    leaseDurationInHours: methods.watch("leaseDurationInHours"),
                    durationThresholds: methods.watch("durationThresholds"),
                    costReportGroup: costReportGroupToSave(
                      {
                        costReportGroupEnabled: methods.watch(
                          "costReportGroupEnabled",
                        ),
                        selectedCostReportGroup: methods.watch(
                          "selectedCostReportGroup",
                        ),
                      },
                      requireCostReportGroup,
                    ),
                    blueprintId: methods.watch("blueprintId"),
                    blueprintName: methods.watch("blueprintName"),
                    allowOwnerToShareLease: methods.watch(
                      "allowOwnerToShareLease",
                    ),
                    predictiveBudgetEnabled: methods.watch(
                      "predictiveBudgetEnabled",
                    ),
                    // Rows are saved only with predictive controls on (see
                    // toTemplateBudgetFields), so the review shows them only then.
                    rateLimits: methods.watch("predictiveBudgetEnabled")
                      ? tryParseRateLimitFormRows(methods.watch("rateLimits"))
                      : undefined,
                    bedrockTokenMonitoringEnabled: methods.watch(
                      "bedrockTokenMonitoringEnabled",
                    ),
                    sandboxSpacesEnabled: methods.watch("sandboxSpacesEnabled"),
                    allowedModelIds: methods.watch("allowedModelIds"),
                    defaultModelId: methods.watch("defaultModelId"),
                    defaultPermissionSet: methods.watch("defaultPermissionSet"),
                    allowedPermissionSets: methods.watch(
                      "allowedPermissionSets",
                    ),
                  }}
                  showEditButtons={false}
                  useRequestAccessTerminology
                  leaseSharingEnabled={leaseSharingEnabled}
                  sandboxSpacesEnabled={sandboxSpacesEnabled}
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
