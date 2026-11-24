// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert } from "@cloudscape-design/components";

import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import { MAINTENANCE_MODE_HREF } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/MaintenanceForm";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";

export const MaintenanceBanner = () => {
  const { data: config } = useGetConfigurations();

  if (config?.maintenance.enabled) {
    return (
      <Alert type="warning" header="Maintenance Mode" dismissible={false}>
        Innovation Sandbox on AWS is currently in maintenance mode. Access to
        the web application is limited to admin users. To disable maintenance
        mode, admins can update the{" "}
        <TextLink to={MAINTENANCE_MODE_HREF}>Settings</TextLink> page.
      </Alert>
    );
  }
};
