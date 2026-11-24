// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";

type LeaseTemplateCreateFields = Omit<
  LeaseTemplateView,
  | "uuid"
  | "createdBy"
  | "blueprintName"
  | "meta"
  | "defaultPermissionSet"
  | "allowedPermissionSets"
>;

export type CreateLeaseTemplateRequest = LeaseTemplateCreateFields & {
  defaultPermissionSetArn: string;
  allowedPermissionSetArns: string[];
};

export type UpdateLeaseTemplateRequest = Omit<
  LeaseTemplateView,
  "uuid" | "blueprintName" | "createdBy"
>;
