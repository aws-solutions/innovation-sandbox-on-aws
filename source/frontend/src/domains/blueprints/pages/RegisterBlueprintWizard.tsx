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

import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { BlueprintSummary } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/BlueprintSummary";
import {
  BasicDetailsForm,
  DeploymentConfigurationForm,
  StackSetSelectionForm,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/forms";
import { transformRegionConcurrencyTypeForApi } from "@amzn/innovation-sandbox-frontend/domains/blueprints/helpers";
import { useRegisterBlueprint } from "@amzn/innovation-sandbox-frontend/domains/blueprints/hooks";
import {
  DEPLOYMENT_STRATEGY_CONFIGS,
  REGION_CONCURRENCY_OPTIONS,
  RegisterBlueprintRequest,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import {
  BLUEPRINT_DEPLOYMENT_TIMEOUT,
  BlueprintWizardFormValues,
  createBlueprintWizardValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const RegisterBlueprintWizard = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Blueprints", href: "/blueprints" },
      { text: "Register blueprint", href: "/blueprints/register" },
    ]);
  }, [setBreadcrumb]);

  const { mutateAsync: registerBlueprint, isPending: isSaving } =
    useRegisterBlueprint();

  // Create validation schema
  const validationSchema = useMemo(
    () => createBlueprintWizardValidationSchema(),
    [],
  );

  // Single useForm instance for entire wizard
  const methods = useForm({
    resolver: zodResolver(validationSchema),
    mode: "all",
    defaultValues: {
      name: "",
      tags: [],
      selectedStackSet: undefined,
      selectedRegions: [],
      deploymentTimeout: BLUEPRINT_DEPLOYMENT_TIMEOUT.DEFAULT,
      deploymentStrategy: "Default",
      regionConcurrencyType: REGION_CONCURRENCY_OPTIONS.SEQUENTIAL,
      maxConcurrentPercentage:
        DEPLOYMENT_STRATEGY_CONFIGS.Default.maxConcurrentPercentage,
      failureTolerancePercentage:
        DEPLOYMENT_STRATEGY_CONFIGS.Default.failureTolerancePercentage,
      concurrencyMode: DEPLOYMENT_STRATEGY_CONFIGS.Default.concurrencyMode,
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
      const stepFields: Array<Array<keyof BlueprintWizardFormValues>> = [
        ["name", "tags"],
        ["selectedStackSet"],
        [
          "selectedRegions",
          "deploymentTimeout",
          "deploymentStrategy",
          "regionConcurrencyType",
          "maxConcurrentPercentage",
          "failureTolerancePercentage",
          "concurrencyMode",
        ],
        [], // Review step has no fields to validate
      ];

      const currentStepFields = stepFields[activeStepIndex];
      const currentStepHasErrors = currentStepFields.some(
        (field) => getFieldState(field).error !== undefined,
      );

      if (currentStepHasErrors) {
        return;
      }
    }

    clearErrors();
    setActiveStepIndex(requestedStepIndex);
  };

  const handleSubmit = async () => {
    const isValid = await trigger();
    if (!isValid) {
      showErrorToast(
        "Please correct the validation errors in the form before submitting.",
        "Validation Failed",
      );
      return;
    }

    try {
      const values = methods.getValues();

      // Defensive check: ensure selectedStackSet exists (should be guaranteed by validation)
      if (!values.selectedStackSet) {
        showErrorToast("Please select a StackSet", "Validation Error");
        return;
      }

      const tagsRecord = (values.tags || []).reduce(
        (acc, tag) => {
          // Include tags with keys, even if value is empty (AWS allows empty values)
          if (tag.key && tag.key.trim() !== "") {
            acc[tag.key] = tag.value || ""; // Use empty string if value is undefined
          }
          return acc;
        },
        {} as Record<string, string>,
      );

      const request: RegisterBlueprintRequest = {
        name: values.name.trim(),
        stackSetId: values.selectedStackSet.stackSetId,
        regions: values.selectedRegions,
        tags: Object.keys(tagsRecord).length > 0 ? tagsRecord : undefined,
        deploymentTimeoutMinutes: values.deploymentTimeout,
        regionConcurrencyType: transformRegionConcurrencyTypeForApi(
          values.regionConcurrencyType.value,
        ),
        maxConcurrentPercentage: values.maxConcurrentPercentage,
        failureTolerancePercentage: values.failureTolerancePercentage,
        concurrencyMode: values.concurrencyMode,
      };

      await registerBlueprint(request);
      showSuccessToast("Blueprint registered successfully");
      navigate("/blueprints");
    } catch (error) {
      showErrorToast(
        error instanceof Error
          ? error.message
          : "Failed to register blueprint. Please try again.",
        "Registration Failed",
      );
    }
  };

  const handleCancel = () => {
    navigate("/blueprints");
  };

  return (
    <FormProvider {...methods}>
      <ContentLayout
        header={
          <Header
            variant="h1"
            description="Register a new blueprint for automated resource deployment"
          >
            Register Blueprint
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
            submitButton: "Register blueprint",
            optional: "optional",
          }}
          onNavigate={handleNavigate}
          onCancel={handleCancel}
          onSubmit={handleSubmit}
          activeStepIndex={activeStepIndex}
          allowSkipTo
          isLoadingNextStep={isSaving}
          steps={[
            {
              title: "Blueprint Configuration",
              description: "Configure basic blueprint settings",
              content: (
                <Container>
                  <BasicDetailsForm />
                </Container>
              ),
              isOptional: false,
            },
            {
              title: "StackSet Selection",
              description: "Choose a StackSet for your blueprint",
              content: (
                <Container>
                  <StackSetSelectionForm />
                </Container>
              ),
              isOptional: false,
            },
            {
              title: "Deployment Configuration",
              description:
                "Configure deployment regions, strategy, and timeout",
              content: (
                <Container>
                  <DeploymentConfigurationForm />
                </Container>
              ),
              isOptional: false,
            },
            {
              title: "Review and Submit",
              description: "Review your blueprint configuration",
              content: (
                <BlueprintSummary
                  blueprint={{
                    name: methods.watch("name"),
                    tags: methods.watch("tags"),
                    selectedStackSet: methods.watch("selectedStackSet"),
                    selectedRegions: methods.watch("selectedRegions"),
                    deploymentTimeout: methods.watch("deploymentTimeout"),
                    deploymentStrategy: methods.watch("deploymentStrategy"),
                    regionConcurrencyType: methods.watch(
                      "regionConcurrencyType",
                    ),
                    maxConcurrentPercentage: methods.watch(
                      "maxConcurrentPercentage",
                    ),
                    failureTolerancePercentage: methods.watch(
                      "failureTolerancePercentage",
                    ),
                    concurrencyMode: methods.watch("concurrencyMode"),
                  }}
                  showEditButtons={false}
                />
              ),
              isOptional: false,
            },
          ]}
        />
      </ContentLayout>
    </FormProvider>
  );
};
