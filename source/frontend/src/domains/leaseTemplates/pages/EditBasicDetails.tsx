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
import { useEffect } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { useNavigate, useParams } from "react-router-dom";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  BasicDetailsForm,
  BasicDetailsFormValues,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/BasicDetailsForm";
import {
  useGetLeaseTemplateById,
  useUpdateLeaseTemplate,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { BasicDetailsValidationSchema } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const EditBasicDetails = () => {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const query = useGetLeaseTemplateById(uuid!);
  const { data: leaseTemplate, isLoading, isError, refetch, error } = query;

  const { mutateAsync: updateLeaseTemplate, isPending: isUpdating } =
    useUpdateLeaseTemplate();

  // Initialize form with React Hook Form
  const methods = useForm<BasicDetailsFormValues>({
    resolver: zodResolver(BasicDetailsValidationSchema),
    mode: "all",
    defaultValues: {
      name: "",
      description: "",
      requiresApproval: true,
      visibility: "PRIVATE",
    },
  });

  const {
    handleSubmit,
    reset,
    formState: { isValid, isDirty },
  } = methods;

  // Reset form when lease template data loads
  useEffect(() => {
    if (leaseTemplate) {
      reset({
        name: leaseTemplate.name,
        description: leaseTemplate.description || "",
        requiresApproval: leaseTemplate.requiresApproval,
        visibility: leaseTemplate.visibility,
      });
    }
  }, [leaseTemplate, reset]);

  // Set page breadcrumb on page init
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Lease Templates", href: "/lease_templates" },
      { text: leaseTemplate?.name ?? "...", href: `/lease_templates/${uuid}` },
      { text: "Edit Basic Details", href: "" },
    ]);
    setTools(<Markdown file="edit-lease-template-basic-details" />);
  }, [leaseTemplate, uuid, setBreadcrumb]);

  const onSubmit = async (data: BasicDetailsFormValues) => {
    if (!leaseTemplate) return;

    try {
      const updatedLeaseTemplate: LeaseTemplate = {
        ...leaseTemplate,
        name: data.name,
        description: data.description || "",
        requiresApproval: data.requiresApproval,
        visibility: data.visibility,
      };

      await updateLeaseTemplate(updatedLeaseTemplate);
      showSuccessToast("Basic details updated successfully.");
      navigate(`/lease_templates/${uuid}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while updating basic details.";
      showErrorToast(
        `Failed to update basic details: ${errorMessage} Please check your inputs and try again.`,
        "Update Failed",
      );
    }
  };

  const handleCancel = () => {
    navigate(`/lease_templates/${uuid}`);
  };

  if (isLoading) {
    return <Loader />;
  }

  if (isError || !leaseTemplate) {
    return (
      <ErrorPanel
        description="There was a problem loading this lease template."
        retry={refetch}
        error={error as Error}
      />
    );
  }

  return (
    <ContentLayout>
      <FormProvider {...methods}>
        <form onSubmit={handleSubmit(onSubmit)}>
          <SpaceBetween size="l">
            <Container
              header={<Header variant="h2">Edit Basic Details</Header>}
            >
              <BasicDetailsForm />
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
                  formAction={"submit"}
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
