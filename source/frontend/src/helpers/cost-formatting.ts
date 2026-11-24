// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatCurrency } from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

/**
 * Formats console cost figures while distinguishing positive sub-cent spend
 * from zero. Notification emails continue to use the shared formatter.
 */
export const formatCostAmount = (amount: number): string =>
  amount > 0 && amount < 0.005 ? "< USD 0.01" : formatCurrency(amount);
