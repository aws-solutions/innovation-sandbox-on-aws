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
  UserSelectionStep,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/wizard-steps";
import { useRequestNewLease } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { NewLeaseRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useAppLayoutContext } from "@aws-northstar/ui/components/AppLayout";

export const AssignLease = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const { mutateAsync: requestNewLease, isPending: isSubmitting } =
    useRequestNewLease();

  // Form state
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [leaseTemplateUuid, setLeaseTemplateUuid] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const [acceptTerms, setAcceptTerms] = useState<boolean>(false);
  const [comments, setComments] = useState<string>("");

  // Validation state
  const [isTemplateValid, setIsTemplateValid] = useState<boolean>(false);
  const [isEmailValid, setIsEmailValid] = useState<boolean>(false);
  const [isTermsValid, setIsTermsValid] = useState<boolean>(false);
  const [showValidationErrors, setShowValidationErrors] =
    useState<boolean>(false);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Assign lease", href: "/assign" },
    ]);
    setTools(<Markdown file="assign" />);
  }, []);

  const validateStep = (stepIndex: number): boolean => {
    const isValid = (() => {
      switch (stepIndex) {
        case 0: // Template selection
          return isTemplateValid;
        case 1: // User selection
          return isEmailValid;
        case 2: // Terms
          return isTermsValid;
        default:
          return true;
      }
    })();

    // If validation fails, show errors to help user understand what's wrong
    if (!isValid) {
      setShowValidationErrors(true);
    }

    return isValid;
  };

  const handleSubmit = async () => {
    if (!validateStep(activeStepIndex)) return;

    const request: NewLeaseRequest = {
      leaseTemplateUuid,
      comments,
      userEmail,
    };

    try {
      await requestNewLease(request);
      navigate("/");
      showSuccessToast(`Lease has been assigned to ${userEmail}.`);
    } catch (error) {
      if (error instanceof Error) {
        showErrorToast(`Failed to submit lease assignment: ${error.message}`);
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
            if (showValidationErrors) {
              setShowValidationErrors(false);
            }
          }}
          onValidationChange={setIsTemplateValid}
          showValidationErrors={showValidationErrors}
          label="What lease template would you like to use for this assignment?"
        />
      ),
    },
    {
      title: "Select user",
      content: (
        <UserSelectionStep
          value={userEmail}
          onChange={(email: string) => {
            setUserEmail(email);
            if (showValidationErrors) {
              setShowValidationErrors(false);
            }
          }}
          onValidationChange={setIsEmailValid}
          showValidationErrors={showValidationErrors}
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
            // Clear validation errors when user accepts terms
            if (showValidationErrors) {
              setShowValidationErrors(false);
            }
          }}
          onValidationChange={setIsTermsValid}
          showValidationErrors={showValidationErrors}
          checkboxText="I accept the above terms of service on behalf of the assigned user."
        />
      ),
    },
    {
      title: "Review & Assign",
      content: (
        <Container>
          <SpaceBetween direction="vertical" size="l">
            <Header variant="h3">Review assignment details</Header>
            <ReviewStep
              data={{
                leaseTemplateUuid,
                userEmail,
              }}
            />
            <FormField
              label="Comments"
              description="Optional - add additional comments about this assignment"
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
          description="Create a lease assignment for another user."
        >
          Assign lease
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
          submitButton: "Assign lease",
          optional: "optional",
        }}
      />
    </ContentLayout>
  );
};
