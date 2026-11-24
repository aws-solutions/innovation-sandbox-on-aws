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
import { getLeaseDisplayName } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  useGetLeaseById,
  useUpdateLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { LeasePatchRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { SandboxSpacesEditForm } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/SandboxSpacesEditForm";
import type { SandboxSpacesFormValues } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/SandboxSpacesForm";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const EditSandboxSpacesSettings = () => {
  const { leaseId } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const query = useGetLeaseById(leaseId);
  const { data: lease, isLoading, isError, refetch, error } = query;

  const { mutateAsync: updateLease, isPending: isUpdating } = useUpdateLease();

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
      { text: "Leases", href: "/leases" },
      {
        text: lease ? getLeaseDisplayName(lease) : "...",
        href: `/leases/${leaseId}`,
      },
      { text: "Edit Sandbox Spaces", href: "" },
    ]);
    setTools(<Markdown file="edit-lease-sandbox-spaces" />);
  }, [lease, leaseId, setBreadcrumb]);

  const onSubmit = async (data: SandboxSpacesFormValues) => {
    if (!lease) return;

    const enabled = data.sandboxSpacesEnabled;
    try {
      const leasePatchRequest: LeasePatchRequest = {
        leaseId: lease.leaseId,
        sandboxSpacesEnabled: enabled,
        // null clears: an empty subset inherits every enabled model, and a
        // disabled lease keeps no model selection.
        allowedModelIds:
          enabled && data.allowedModelIds.length > 0
            ? data.allowedModelIds
            : null,
        defaultModelId: enabled ? (data.defaultModelId ?? null) : null,
        bedrockTokenMonitoringEnabled:
          data.bedrockTokenMonitoringEnabled ?? false,
      };

      await updateLease(leasePatchRequest);
      showSuccessToast("Sandbox Spaces settings updated successfully.");
      navigate(`/leases/${leaseId}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while updating Sandbox Spaces settings.";
      showErrorToast(
        `Failed to update Sandbox Spaces settings: ${errorMessage}`,
        "Update Failed",
      );
    }
  };

  const handleCancel = () => {
    navigate(`/leases/${leaseId}`);
  };

  if (isLoading || isLoadingConfig) {
    return <Loader />;
  }

  if (isError || !lease) {
    return (
      <ErrorPanel
        description="There was a problem loading this lease."
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
      // Seed from the lease's own snapshot, not its template: the lease is
      // what the Worker enforces.
      source={lease}
      variant="lease"
      globalSandboxSpacesEnabled={config.agent.sandboxSpacesEnabled}
      allowBedrockTokenMonitoring={config.leases.allowBedrockTokenMonitoring}
      isUpdating={isUpdating}
      onCancel={handleCancel}
      onSubmit={onSubmit}
    />
  );
};
