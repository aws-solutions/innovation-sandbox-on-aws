// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ValidationException } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { ReportingConfig } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";

export function validateCostReportGroup(
  costReportGroup: string | undefined,
  reportingConfig: ReportingConfig,
) {
  if (reportingConfig.requireCostReportGroup && !costReportGroup) {
    throw new ValidationException(
      "A cost report group must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a cost report group.",
    );
  }

  if (
    costReportGroup &&
    !reportingConfig.costReportGroups.includes(costReportGroup)
  ) {
    throw new ValidationException(
      `Cost report group: ${costReportGroup} is not valid`,
    );
  }
}
