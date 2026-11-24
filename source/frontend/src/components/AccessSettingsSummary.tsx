// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { KeyValuePairs, SpaceBetween } from "@cloudscape-design/components";

import { FeatureStatusIndicator } from "@amzn/innovation-sandbox-frontend/components/FeatureStatusIndicator";
import { PermissionSetsTable } from "@amzn/innovation-sandbox-frontend/components/PermissionSetsTable";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

export function AccessSettingsSummary({
  allowOwnerToShareLease,
  leaseSharingEnabled,
  defaultPermissionSet,
  allowedPermissionSets,
}: Readonly<{
  allowOwnerToShareLease?: boolean;
  leaseSharingEnabled: boolean;
  defaultPermissionSet?: PermissionSetReference;
  allowedPermissionSets?: PermissionSetReference[];
}>) {
  return (
    <SpaceBetween size="m">
      <KeyValuePairs
        columns={1}
        items={[
          {
            label: "Lease sharing",
            value: (
              <FeatureStatusIndicator
                featureName="Lease sharing"
                enabled={allowOwnerToShareLease}
                globallyEnabled={leaseSharingEnabled}
              />
            ),
          },
        ]}
      />
      <PermissionSetsTable
        defaultPermissionSet={defaultPermissionSet}
        allowedPermissionSets={allowedPermissionSets}
      />
    </SpaceBetween>
  );
}
