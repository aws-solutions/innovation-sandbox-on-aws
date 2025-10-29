// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const ReportingConfigSchema = z.object({
  costReportGroups: z
    .array(z.string().max(50).min(1))
    .max(100)
    .default([])
    .describe("List of valid cost report groups that can be used"),
  requireCostReportGroup: z
    .boolean()
    .default(false)
    .describe(
      "Whether cost report group is required when creating/updating lease templates",
    ),
});

export type ReportingConfig = z.infer<typeof ReportingConfigSchema>;
