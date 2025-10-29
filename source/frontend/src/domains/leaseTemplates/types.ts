// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LeaseTemplate,
  Visibility,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";

export type LeaseTemplateFormData = LeaseTemplate & {
  maxBudgetEnabled?: boolean;
  maxDurationEnabled?: boolean;
  visibility: {
    label: string;
    value: Visibility;
  };
  costReportGroupEnabled?: boolean;
  selectedCostReportGroup?: {
    label: string;
    value: string;
  };
};

export type NewLeaseTemplate = Omit<LeaseTemplate, "uuid">;
