// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  permissionSetIdFromArn,
  PermissionSetSummarySchema,
} from "@amzn/innovation-sandbox-shared/types/permission-set";

export const PermissionSetViewSchema = PermissionSetSummarySchema.refine(
  ({ permissionSetArn, permissionSetId }) =>
    permissionSetIdFromArn(permissionSetArn) === permissionSetId,
  {
    path: ["permissionSetId"],
    message: "permissionSetId must match permissionSetArn",
  },
);

export type PermissionSetView = z.infer<typeof PermissionSetViewSchema>;
