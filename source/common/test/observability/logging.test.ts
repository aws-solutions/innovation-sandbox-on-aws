// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PersistedLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { diffString } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { describe, expect, test } from "vitest";

describe("logging diffs", () => {
  test("log diff produces expected output", () => {
    const oldLease: PersistedLease = {
      status: "Active",
      uuid: "leaseId",
      userEmail: "user@email.com",
      awsAccountId: "111122223333",
      approvedBy: "mangler@email.com",
      maxSpend: 200,
      budgetThresholds: [
        {
          dollarsSpent: 100,
          action: "ALERT",
        },
      ],
      durationThresholds: [
        {
          hoursRemaining: 48,
          action: "ALERT",
        },
      ],
      startDate: "2024-12-10T08:45:00.000Z",
      expirationDate: "2024-12-20T08:45:00.000Z",
      originalLeaseTemplateUuid: "someId",
      originalLeaseTemplateName: "myTemplate",
      sandboxSpacesEnabled: false,
      lastCheckedDate: "someDate",
      totalCostAccrued: 5,
    };

    const newLease: PersistedLease = {
      status: "Active",
      uuid: "leaseId",
      userEmail: "user@email.com",
      awsAccountId: "111122223333",
      approvedBy: "mangler@email.com",
      maxSpend: 500, //raised budget
      budgetThresholds: [
        {
          dollarsSpent: 400,
          action: "ALERT",
        },
      ],
      durationThresholds: [
        {
          //added new threshold
          hoursRemaining: 72,
          action: "ALERT",
        },
        {
          hoursRemaining: 48,
          action: "ALERT",
        },
      ],
      startDate: "2024-12-10T08:45:00.000Z",
      expirationDate: "2024-12-20T08:45:00.000Z",
      originalLeaseTemplateUuid: "someId",
      originalLeaseTemplateName: "myTemplate",
      sandboxSpacesEnabled: false,
      lastCheckedDate: "someDate",
      totalCostAccrued: 5,
    };

    expect(diffString(oldLease, newLease)).toEqual(
      `{
-  "maxSpend": 200
+  "maxSpend": 500
   "budgetThresholds": {
     "0": {
-      "dollarsSpent": 100
+      "dollarsSpent": 400
     }
   }
   "durationThresholds": {
     "0": {
-      "hoursRemaining": 48
+      "hoursRemaining": 72
     }
+    "1": {"hoursRemaining":48,"action":"ALERT"}
   }
}`,
    );
  });
});
