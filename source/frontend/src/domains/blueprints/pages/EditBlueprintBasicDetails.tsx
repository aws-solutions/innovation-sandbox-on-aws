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

import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { BasicDetailsForm } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/forms";
import {
  useGetBlueprintById,
  useUpdateBlueprint,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/hooks";
import {
  BasicDetailsFormValues,
  createBasicDetailsValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const EditBlueprintBasicDetails = () => {
  const { blueprintId } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();

  const query = useGetBlueprintById(blueprintId!);
  const { data, isLoading, isError, refetch, error } = query;

  const { mutateAsync: updateBlueprint, isPending: isUpdating } =
    useUpdateBlueprint();

  const methods = useForm<BasicDetailsFormValues>({
    resolver: zodResolver(createBasicDetailsValidationSchema()),
    mode: "all",
    defaultValues: {
      name: "",
      tags: [],
    },
  });

  const {
    handleSubmit,
    reset,
    formState: { isValid, isDirty },
  } = methods;

  useEffect(() => {
    if (data?.blueprint) {
      const tagsArray = data.blueprint.tags
        ? Object.entries(data.blueprint.tags).map(([key, value]) => ({
            key,
            value,
          }))
        : [];

      reset({
        name: data.blueprint.name,
        tags: tagsArray,
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
      { text: "Edit Basic Details", href: "" },
    ]);
  }, [data, blueprintId, setBreadcrumb]);

  const onSubmit = async (formData: BasicDetailsFormValues) => {
    if (!data?.blueprint) return;

    try {
      const tagsRecord = (formData.tags || []).reduce(
        (acc, tag) => {
          // Include tags with keys, even if value is empty (AWS allows empty values)
          if (tag.key && tag.key.trim() !== "") {
            acc[tag.key] = tag.value || ""; // Use empty string if value is undefined
          }
          return acc;
        },
        {} as Record<string, string>,
      );

      await updateBlueprint({
        id: blueprintId!,
        updates: {
          name: formData.name.trim(),
          tags: tagsRecord, // Always send tags (empty object or with values)
        },
      });

      showSuccessToast("Blueprint details updated successfully");
      navigate(`/blueprints/${blueprintId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while updating blueprint details.";
      showErrorToast(
        `Failed to update blueprint details: ${errorMessage} Please check your inputs and try again.`,
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
