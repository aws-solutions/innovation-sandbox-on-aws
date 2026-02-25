// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RegionConcurrencyType } from "@aws-sdk/client-cloudformation";
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

import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditDeploymentConfigForm } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/forms";
import { transformRegionConcurrencyTypeForApi } from "@amzn/innovation-sandbox-frontend/domains/blueprints/helpers";
import {
  useGetBlueprintById,
  useUpdateBlueprint,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/hooks";
import { REGION_CONCURRENCY_OPTIONS } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import {
  BLUEPRINT_DEPLOYMENT_TIMEOUT,
  EditDeploymentConfigFormValues,
  EditDeploymentConfigValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const EditBlueprintDeploymentConfig = () => {
  const { blueprintId } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();

  const query = useGetBlueprintById(blueprintId!);
  const { data, isLoading, isError, refetch, error } = query;

  const { mutateAsync: updateBlueprint, isPending: isUpdating } =
    useUpdateBlueprint();

  const methods = useForm<EditDeploymentConfigFormValues>({
    resolver: zodResolver(EditDeploymentConfigValidationSchema),
    mode: "all",
    defaultValues: {
      deploymentTimeout: BLUEPRINT_DEPLOYMENT_TIMEOUT.DEFAULT,
      deploymentStrategy: "Default",
      regionConcurrencyType: REGION_CONCURRENCY_OPTIONS.SEQUENTIAL,
      maxConcurrentPercentage: 100,
      failureTolerancePercentage: 0,
      concurrencyMode: "STRICT_FAILURE_TOLERANCE",
    },
  });

  const {
    handleSubmit,
    reset,
    formState: { isValid, isDirty },
  } = methods;

  useEffect(() => {
    if (data?.blueprint && data?.stackSets?.[0]) {
      reset({
        deploymentTimeout: data.blueprint.deploymentTimeoutMinutes,
        deploymentStrategy: "Custom",
        regionConcurrencyType:
          data.blueprint.regionConcurrencyType ===
          RegionConcurrencyType.SEQUENTIAL
            ? REGION_CONCURRENCY_OPTIONS.SEQUENTIAL
            : REGION_CONCURRENCY_OPTIONS.PARALLEL,
        maxConcurrentPercentage: data.stackSets[0].maxConcurrentPercentage,
        failureTolerancePercentage:
          data.stackSets[0].failureTolerancePercentage,
        concurrencyMode: data.stackSets[0].concurrencyMode,
      });
    }
  }, [data, reset]);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Blueprints", href: "/blueprints" },
      {
        text: data?.blueprint?.name ?? "...",
        href: `/blueprints/${blueprintId}`,
      },
      { text: "Edit Deployment Configuration", href: "" },
    ]);
  }, [data, blueprintId, setBreadcrumb]);

  const onSubmit = async (formData: EditDeploymentConfigFormValues) => {
    if (!data?.blueprint) return;

    try {
      await updateBlueprint({
        id: blueprintId!,
        updates: {
          deploymentTimeoutMinutes: formData.deploymentTimeout,
          regionConcurrencyType: transformRegionConcurrencyTypeForApi(
            formData.regionConcurrencyType.value,
          ),
          maxConcurrentPercentage: formData.maxConcurrentPercentage,
          failureTolerancePercentage: formData.failureTolerancePercentage,
          concurrencyMode: formData.concurrencyMode,
        },
      });

      showSuccessToast("Deployment configuration updated successfully");
      navigate(`/blueprints/${blueprintId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while updating deployment configuration.";
      showErrorToast(
        `Failed to update deployment configuration: ${errorMessage} Please check your inputs and try again.`,
        "Update Failed",
      );
    }
  };

  const handleCancel = () => {
    navigate(`/blueprints/${blueprintId}`);
  };

  if (isLoading) {
    return <Loader />;
  }

  if (isError || !data?.blueprint) {
    return (
      <ErrorPanel
        description="There was a problem loading this blueprint."
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
              header={
                <Header variant="h2">Edit Deployment Configuration</Header>
              }
            >
              <EditDeploymentConfigForm />
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
