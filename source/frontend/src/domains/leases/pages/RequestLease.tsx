// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";

import {
  Container,
  Header,
  SpaceBetween,
  Wizard,
  WizardProps,
} from "@cloudscape-design/components";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import TextareaField from "@amzn/innovation-sandbox-frontend/components/FormFields/TextareaField";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { ReviewForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/ReviewForm";
import { TemplateSelectionForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TemplateSelectionForm";
import { TermsOfServiceForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TermsOfServiceForm";
import { useRequestNewLease } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { NewLeaseRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import {
  RequestLeaseFormValues,
  RequestLeaseValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/validation";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const RequestLease = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const { mutateAsync: requestNewLease, isPending: isSubmitting } =
    useRequestNewLease();

  // Single useForm instance for the entire wizard
  const methods = useForm<RequestLeaseFormValues>({
    resolver: zodResolver(RequestLeaseValidationSchema),
    mode: "all",
    defaultValues: {
      leaseTemplateUuid: "",
      acceptTerms: false,
      comments: "",
    },
  });

  const { trigger, clearErrors, getFieldState, watch } = methods;

  // Reset acceptTerms when template changes
  const leaseTemplateUuid = watch("leaseTemplateUuid");
  useEffect(() => {
    methods.resetField("acceptTerms");
  }, [leaseTemplateUuid, methods]);

  // Track active wizard step
  const [activeStepIndex, setActiveStepIndex] = useState(0);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Request lease", href: "/request" },
    ]);
    setTools(<Markdown file="request-lease" />);
  }, []);

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
      const stepFields: Array<Array<keyof RequestLeaseFormValues>> = [
        ["leaseTemplateUuid"], // Template selection
        ["acceptTerms"], // Terms of service
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

    clearErrors();
    setActiveStepIndex(requestedStepIndex);
  };

  const handleSubmit = async () => {
    const isValid = await trigger();
    if (!isValid) {
      // Navigate to ToS step — the only validation that can fail at submit time
      // (template selection and email have inline validation that blocks forward navigation)
      setActiveStepIndex(1);
      showErrorToast(
        "Please correct the validation errors before submitting.",
        "Validation Failed",
      );
      return;
    }

    try {
      const values = methods.getValues();

      const request: NewLeaseRequest = {
        leaseTemplateUuid: values.leaseTemplateUuid,
        comments: values.comments,
      };

      await requestNewLease(request);
      navigate("/");
      showSuccessToast("Your request for a new lease has been submitted.");
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while submitting the lease request.";
      showErrorToast(`Failed to submit lease request: ${errorMessage}`);
    }
  };

  const onCancel = () => {
    navigate("/");
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Request to lease an AWS sandbox account."
        >
          Request lease
        </Header>
      }
    >
      <FormProvider {...methods}>
        <Wizard
          steps={[
            {
              title: "Select lease template",
              content: <TemplateSelectionForm />,
            },
            {
              title: "Terms of Service",
              content: <TermsOfServiceForm />,
            },
            {
              title: "Review & Submit",
              content: (
                <SpaceBetween direction="vertical" size="l">
                  <ReviewForm
                    data={{
                      leaseTemplateUuid: methods.watch("leaseTemplateUuid"),
                    }}
                  />
                  <Container>
                    <TextareaField
                      controllerProps={{
                        control: methods.control,
                        name: "comments",
                      }}
                      formFieldProps={{
                        label: "Comments",
                        description:
                          "Optional - add additional comments to support your request",
                      }}
                      textareaProps={{
                        placeholder: "Enter any additional comments...",
                        rows: 3,
                      }}
                    />
                  </Container>
                </SpaceBetween>
              ),
            },
          ]}
          activeStepIndex={activeStepIndex}
          onNavigate={handleNavigate}
          onCancel={onCancel}
          onSubmit={handleSubmit}
          isLoadingNextStep={isSubmitting}
          allowSkipTo
          i18nStrings={{
            stepNumberLabel: (stepNumber) => `Step ${stepNumber}`,
            collapsedStepsLabel: (stepNumber, stepsCount) =>
              `Step ${stepNumber} of ${stepsCount}`,
            skipToButtonLabel: (step) => `Skip to ${step.title}`,
            navigationAriaLabel: "Steps",
            cancelButton: "Cancel",
            previousButton: "Previous",
            nextButton: "Next",
            submitButton: "Submit request",
            optional: "optional",
          }}
        />
      </FormProvider>
    </ContentLayout>
  );
};
