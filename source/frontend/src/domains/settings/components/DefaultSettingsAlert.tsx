// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert } from "@cloudscape-design/components";

export function DefaultSettingsAlert() {
  return (
    <Alert type="info" header="Default settings have not been saved">
      Review the values, then save these settings.
    </Alert>
  );
}
