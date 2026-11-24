// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { SandboxSpacesEditForm } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/SandboxSpacesEditForm";
import type { SandboxSpacesFormValues } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/SandboxSpacesForm";
import {
  useGetLeaseTemplateById,
  useUpdateLeaseTemplate,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import type { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const EditSandboxSpaces = () => {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const query = useGetLeaseTemplateById(uuid);
  const { data: leaseTemplate, isLoading, isError, refetch, error } = query;

  const { mutateAsync: updateLeaseTemplate, isPending: isUpdating } =
    useUpdateLeaseTemplate();

  const {
    data: config,
    isLoading: isLoadingConfig,
    isError: isConfigError,
    refetch: refetchConfig,
    error: configError,
  } = useGetConfigurations();
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Lease Templates", href: "/lease_templates" },
      { text: leaseTemplate?.name ?? "...", href: `/lease_templates/${uuid}` },
      { text: "Edit Sandbox Spaces", href: "" },
    ]);
    setTools(<Markdown file="edit-lease-template-sandbox-spaces" />);
  }, [leaseTemplate, uuid, setBreadcrumb]);

  const onSubmit = async (data: SandboxSpacesFormValues) => {
    if (!leaseTemplate) return;

    try {
      const updatedLeaseTemplate: LeaseTemplateView = {
        ...leaseTemplate,
        sandboxSpacesEnabled: data.sandboxSpacesEnabled,
        // Only persist a model subset when enabled; empty/undefined inherits the
        // globally enabled set.
        allowedModelIds:
          data.sandboxSpacesEnabled && data.allowedModelIds.length > 0
            ? data.allowedModelIds
            : undefined,
        defaultModelId: data.sandboxSpacesEnabled
          ? data.defaultModelId
          : undefined,
        bedrockTokenMonitoringEnabled:
          data.bedrockTokenMonitoringEnabled ?? false,
      };

      await updateLeaseTemplate(updatedLeaseTemplate);
      showSuccessToast("Sandbox Spaces settings updated successfully.");
      navigate(`/lease_templates/${uuid}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while updating Sandbox Spaces settings.";
      showErrorToast(
        `Failed to update Sandbox Spaces settings: ${errorMessage} Please check your inputs and try again.`,
        "Update Failed",
      );
    }
  };

  const handleCancel = () => {
    navigate(`/lease_templates/${uuid}`);
  };

  if (isLoading || isLoadingConfig) {
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

  if (isConfigError || !config) {
    return (
      <ErrorPanel
        description="There was a problem loading the current settings."
        retry={refetchConfig}
        error={configError as Error}
      />
    );
  }

  return (
    <SandboxSpacesEditForm
      source={leaseTemplate}
      variant="template"
      globalSandboxSpacesEnabled={config.agent.sandboxSpacesEnabled}
      allowBedrockTokenMonitoring={config.leases.allowBedrockTokenMonitoring}
      isUpdating={isUpdating}
      onCancel={handleCancel}
      onSubmit={onSubmit}
    />
  );
};
