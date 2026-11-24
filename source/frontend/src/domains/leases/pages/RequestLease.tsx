// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Container,
  Header,
  SpaceBetween,
  Wizard,
  WizardProps,
} from "@cloudscape-design/components";
import { zodResolver } from "@hookform/resolvers/zod";
import { DateTime } from "luxon";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import TextareaField from "@amzn/innovation-sandbox-frontend/components/FormFields/TextareaField";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  assignmentsFingerprint,
  upsertOwnerAssignment,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import { AssignmentsForm } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsForm";
import { PendingAssignmentsList } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PendingAssignmentsList";
import { ReviewForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/ReviewForm";
import { TemplateSelectionForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TemplateSelectionForm";
import { TermsOfServiceForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TermsOfServiceForm";
import { toAssignmentRefs } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { useRequestNewLease } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { NewLeaseRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import {
  RequestLeaseFormValues,
  RequestLeaseValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/validation";
import { useGetLeaseTemplateById } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import { DEFAULT_GROUP_ASSIGNMENT_MODE } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  getUserEmail,
  getUserLabel,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils";

export const RequestLease = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();
  const { user } = useUser();

  const { mutateAsync: requestNewLease, isPending: isSubmitting } =
    useRequestNewLease();

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

  const leaseTemplateUuid = watch("leaseTemplateUuid");
  const assignmentsKey = assignmentsFingerprint(watch("assignments") ?? []);
  useEffect(() => {
    methods.resetField("acceptTerms");
  }, [leaseTemplateUuid, assignmentsKey, methods]);

  const { data: globalConfig } = useGetConfigurations();
  const { data: selectedTemplate, isLoading: isTemplateLoading } =
    useGetLeaseTemplateById(leaseTemplateUuid || undefined);
  const defaultPermissionSetArn =
    selectedTemplate?.defaultPermissionSet?.permissionSetArn;
  const showAssignmentsStep =
    !!globalConfig?.leases?.leaseSharingEnabled &&
    !!selectedTemplate?.allowOwnerToShareLease;
  const owner = useMemo(
    () =>
      user?.type === "user"
        ? {
            principalId: user.userId,
            displayName: getUserLabel(user),
            email: getUserEmail(user),
          }
        : undefined,
    [user],
  );

  useEffect(() => {
    if (!showAssignmentsStep || !defaultPermissionSetArn) return;
    const currentAssignments = methods.getValues("assignments") ?? [];
    const updatedAssignments = upsertOwnerAssignment(
      currentAssignments,
      owner,
      defaultPermissionSetArn,
    );
    if (updatedAssignments !== currentAssignments) {
      methods.setValue("assignments", [...updatedAssignments], {
        shouldValidate: true,
      });
    }
  }, [
    leaseTemplateUuid,
    methods,
    owner,
    defaultPermissionSetArn,
    showAssignmentsStep,
  ]);

  // Track active wizard step
  const [activeStepIndex, setActiveStepIndex] = useState(0);

  const stepFields: Array<Array<keyof RequestLeaseFormValues>> = [
    ["leaseTemplateUuid"], // Template selection
    ...(showAssignmentsStep
      ? [["assignments"] as Array<keyof RequestLeaseFormValues>]
      : []),
    ["acceptTerms"], // Terms of service
    [], // Review step has no fields to validate
  ];

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

  const showSubmitErrorToast = (error: unknown) => {
    if (error instanceof ApiError && error.statusCode === 429) {
      // The per-user lease rate limit returns a computed retryAt; AWS SDK
      // throttles (mapped to 429 by the API error handler) do not. Only the
      // former should show the lease-limit wording.
      const retryAt = error.data?.retryAt
        ? DateTime.fromISO(error.data.retryAt)
        : undefined;

      if (!retryAt) {
        // No retryAt: a transient throttle, not the user's limit. Surface the
        // server's own message instead of mislabeling it as the lease limit.
        showErrorToast(error.message);
        return;
      }

      showErrorToast(
        retryAt.isValid
          ? `You've reached the lease request limit. You can request another lease after ${retryAt.toLocaleString(
              DateTime.DATETIME_SHORT,
            )}.`
          : "You've reached the lease request limit. Try again later.",
      );
      return;
    }

    const errorMessage =
      error instanceof Error
        ? error.message
        : "An unexpected error occurred while submitting the lease request.";
    showErrorToast(`Failed to submit lease request: ${errorMessage}`);
  };

  const handleSubmit = async () => {
    const isValid = await trigger();
    if (!isValid) {
      // ToS is always the second-to-last step (Review is last). Deriving
      // from stepFields.length keeps this correct if new steps are added.
      setActiveStepIndex(stepFields.length - 2);
      showErrorToast(
        "Please correct the validation errors before submitting.",
        "Validation Failed",
      );
      return;
    }

    try {
      const values = methods.getValues();

      const assignments = showAssignmentsStep
        ? toAssignmentRefs(values.assignments)
        : undefined;

      const request: NewLeaseRequest = {
        leaseTemplateUuid: values.leaseTemplateUuid,
        comments: values.comments,
        ...(assignments ? { assignments } : {}),
      };

      await requestNewLease(request);
      navigate("/");
      showSuccessToast("Your request for a new lease has been submitted.");
    } catch (error) {
      showSubmitErrorToast(error);
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
              content: <TemplateSelectionForm clearAssignmentsOnChange />,
            },
            ...(showAssignmentsStep
              ? [
                  {
                    title: "Configure access",
                    isOptional: true,
                    content: (
                      <AssignmentsForm
                        enablePrincipalSearch={
                          globalConfig?.leases?.enablePrincipalSearch ?? false
                        }
                        groupAssignmentMode={
                          globalConfig?.leases?.groupAssignmentMode ??
                          DEFAULT_GROUP_ASSIGNMENT_MODE
                        }
                        owner={owner}
                        defaultPermissionSet={
                          selectedTemplate?.defaultPermissionSet
                        }
                        allowedPermissionSets={
                          selectedTemplate?.allowedPermissionSets
                        }
                      />
                    ),
                  },
                ]
              : []),
            {
              title: "Terms of Service",
              content: <TermsOfServiceForm />,
            },
            {
              title: "Review & Submit",
              content: isTemplateLoading ? (
                <Loader label="Loading review..." />
              ) : (
                <SpaceBetween direction="vertical" size="l">
                  <ReviewForm
                    data={{
                      leaseTemplateUuid: methods.watch("leaseTemplateUuid"),
                    }}
                  />
                  <PendingAssignmentsList
                    desiredAssignments={methods.watch("assignments")}
                    defaultPermissionSet={
                      selectedTemplate?.defaultPermissionSet
                    }
                    allowedPermissionSets={
                      selectedTemplate?.allowedPermissionSets
                    }
                    ownerEmail={owner?.email}
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
