// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";

import { CleanupForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CleanupForm";
import {
  leasePolicyFields,
  LeasesForm,
  leasesFormSearchFields,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/LeasesForm";
import { NotificationForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/NotificationForm";
import { AdminConfigurationView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { SettingsGroupId } from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import {
  ConfigurationForm,
  useConfigurationForm,
} from "@amzn/innovation-sandbox-frontend/domains/settings/useConfigurationForm";

import {
  configurationGroup,
  SettingsGroupController,
} from "./configurationGroup";
import { costSettingsGroup } from "./CostSettingsGroup";
import { generalSettingsGroup } from "./GeneralSettingsGroup";
import { useSandboxSpacesSettingsGroup } from "./SandboxSpacesSettingsGroup";

function useSectionContext({ methods, conflict }: ConfigurationForm) {
  // The methods object stays stable while its formState property changes.
  return useMemo(
    () => ({ methods, conflict }),
    [methods, methods.formState, conflict],
  );
}

export function useSettingsGroups(config: AdminConfigurationView) {
  // Cost and Lease policies share one form and concurrency token for the leases API.
  const leases = useConfigurationForm(
    "leases",
    config.leases,
    leasesFormSearchFields,
  );
  const cleanup = useConfigurationForm("cleanup", config.cleanup);
  const maintenance = useConfigurationForm("maintenance", config.maintenance);
  const termsOfService = useConfigurationForm(
    "termsOfService",
    config.termsOfService,
  );
  const notification = useConfigurationForm(
    "notification",
    config.notification,
  );
  const costReporting = useConfigurationForm(
    "costReporting",
    config.costReporting,
  );
  const agent = useConfigurationForm("agent", config.agent);
  const sandboxSpaces = useSandboxSpacesSettingsGroup(
    agent,
    config.bedrockInferenceProfilePatterns,
  );
  const groups: Record<SettingsGroupId, SettingsGroupController> = {
    general: generalSettingsGroup(maintenance, termsOfService, config),
    "lease-policies": {
      ...configurationGroup([
        { label: "Lease policies", form: leases, fields: leasePolicyFields },
      ]),
      render: (visible) => visible && <LeasesForm group="lease-policies" />,
    },
    cost: costSettingsGroup(leases, costReporting),
    "account-cleanup": {
      ...configurationGroup([{ label: "Account cleanup", form: cleanup }]),
      render: (visible) => visible && <CleanupForm />,
    },
    notifications: {
      ...configurationGroup([{ label: "Notifications", form: notification }]),
      render: (visible) => visible && <NotificationForm />,
    },
    "sandbox-spaces": sandboxSpaces,
  };
  const leasesContext = useSectionContext(leases);
  const cleanupContext = useSectionContext(cleanup);
  const maintenanceContext = useSectionContext(maintenance);
  const termsOfServiceContext = useSectionContext(termsOfService);
  const notificationContext = useSectionContext(notification);
  const costReportingContext = useSectionContext(costReporting);
  const agentContext = useSectionContext(agent);
  const sections = useMemo(
    () => ({
      leases: leasesContext,
      cleanup: cleanupContext,
      maintenance: maintenanceContext,
      termsOfService: termsOfServiceContext,
      notification: notificationContext,
      costReporting: costReportingContext,
      agent: agentContext,
    }),
    [
      leasesContext,
      cleanupContext,
      maintenanceContext,
      termsOfServiceContext,
      notificationContext,
      costReportingContext,
      agentContext,
    ],
  );
  return { groups, sections };
}
