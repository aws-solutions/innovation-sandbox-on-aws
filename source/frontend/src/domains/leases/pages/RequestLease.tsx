// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  Container,
  ContentLayout,
  FormField,
  Header,
  SpaceBetween,
  Textarea,
  Wizard,
} from "@cloudscape-design/components";

import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  ReviewStep,
  TemplateSelectionStep,
  TermsOfServiceStep,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/wizard-steps";
import { useRequestNewLease } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { NewLeaseRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useAppLayoutContext } from "@aws-northstar/ui/components/AppLayout";
export const RequestLease = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const { mutateAsync: requestNewLease, isPending: isSubmitting } =
    useRequestNewLease();

  // Form state
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [leaseTemplateUuid, setLeaseTemplateUuid] = useState<string>("");
  const [acceptTerms, setAcceptTerms] = useState<boolean>(false);
  const [comments, setComments] = useState<string>("");

  // Validation state
  const [isTemplateValid, setIsTemplateValid] = useState<boolean>(false);
  const [isTermsValid, setIsTermsValid] = useState<boolean>(false);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Request lease", href: "/request" },
    ]);
    setTools(<Markdown file="request" />);
  }, []);

  const validateStep = (stepIndex: number): boolean => {
    switch (stepIndex) {
      case 0: // Template selection
        return isTemplateValid;
      case 1: // Terms
        return isTermsValid;
      default:
        return true;
    }
  };

  const handleSubmit = async () => {
    if (!validateStep(activeStepIndex)) return;

    const request: NewLeaseRequest = {
      leaseTemplateUuid,
      comments,
    };

    try {
      await requestNewLease(request);
      navigate("/");
      showSuccessToast("Your request for a new lease has been submitted.");
    } catch (error) {
      if (error instanceof Error) {
        showErrorToast(`Failed to submit lease request: ${error.message}`);
      }
    }
  };

  const onCancel = () => {
    navigate("/");
  };

  const steps = [
    {
      title: "Select lease template",
      content: (
        <TemplateSelectionStep
          value={leaseTemplateUuid}
          onChange={(templateId: string) => {
            setLeaseTemplateUuid(templateId);
          }}
          onValidationChange={setIsTemplateValid}
          label="What lease template would you like to use to request a lease?"
        />
      ),
    },
    {
      title: "Terms of Service",
      content: (
        <TermsOfServiceStep
          acceptTerms={acceptTerms}
          onAcceptTermsChange={(accepted: boolean) => {
            setAcceptTerms(accepted);
          }}
          onValidationChange={setIsTermsValid}
          checkboxText="I accept the above terms of service."
        />
      ),
    },
    {
      title: "Review & Submit",
      content: (
        <Container>
          <SpaceBetween direction="vertical" size="l">
            <Header variant="h3">Review request details</Header>
            <ReviewStep
              data={{
                leaseTemplateUuid,
              }}
            />
            <FormField
              label="Comments"
              description="Optional - add additional comments to support your request"
            >
              <Textarea
                value={comments}
                onChange={({ detail }) => setComments(detail.value)}
                placeholder="Enter any additional comments..."
                rows={3}
              />
            </FormField>
          </SpaceBetween>
        </Container>
      ),
    },
  ];

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
      <Wizard
        steps={steps}
        activeStepIndex={activeStepIndex}
        onNavigate={({ detail }) => {
          // Only allow navigation if current step is valid or going backwards
          if (
            detail.requestedStepIndex < activeStepIndex ||
            validateStep(activeStepIndex)
          ) {
            setActiveStepIndex(detail.requestedStepIndex);
          }
        }}
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
    </ContentLayout>
  );
};
