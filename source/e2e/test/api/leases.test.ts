// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { retryAsync } from "ts-retry/lib/esm/index.js";
import { beforeAll, describe, expect, inject, it } from "vitest";

import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import { LeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  Lease,
  LeaseKeySchema,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  getSignedJwt,
  testIsbUser,
  userAgentHeader,
} from "@amzn/innovation-sandbox-e2e/test/utils/fixtures.js";

let apiBaseUrl: string;
let leaseStore: LeaseStore;
let leaseTemplateStore: LeaseTemplateStore;
let token: string;

beforeAll(async () => {
  const {
    cloudfrontDistributionUrl,
    leaseTable,
    leaseTemplateTable,
    jwtSecret,
  } = inject("testConfiguration");

  apiBaseUrl = `${cloudfrontDistributionUrl}/api`;
  leaseStore = IsbServices.leaseStore({
    LEASE_TABLE_NAME: leaseTable,
    USER_AGENT_EXTRA: "InnovationSandbox-E2E",
  });
  leaseTemplateStore = IsbServices.leaseTemplateStore({
    LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
    USER_AGENT_EXTRA: "InnovationSandbox-E2E",
  });
  token = getSignedJwt(jwtSecret);
});

describe("leases api", () => {
  describe("authorization", () => {
    it("should return 401 when bearer token is not provided", async () => {
      const response = await fetch(`${apiBaseUrl}/leases`, {
        method: "GET",
        headers: {
          // No Authorization header containing bearer token present
          "User-Agent": userAgentHeader,
        },
      });

      const jsonResponseBody: any = await response.json();

      expect(response.status).toBe(401);
      expect(jsonResponseBody).toEqual({
        message: "Unauthorized",
      });
    });
  });

  it("should return 200 and get leases", async () => {
    const leaseKey = generateSchemaData(LeaseKeySchema);
    const leaseId = base64EncodeCompositeKey(leaseKey);
    const lease = generateSchemaData(
      MonitoredLeaseSchema.omit({ meta: true }),
      leaseKey,
    );
    const newItem = await leaseStore.create(lease);

    const expectedLeaseResponse = {
      ...newItem,
      leaseId: leaseId,
    };

    const response = await fetch(`${apiBaseUrl}/leases`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgentHeader,
      },
    });
    const jsonResponseBody: any = await response.json();

    expect(response.status).toBe(200);
    expect(jsonResponseBody.data.result).toEqual(
      expect.arrayContaining([expect.objectContaining(expectedLeaseResponse)]),
    );

    await leaseStore.delete({ userEmail: lease.userEmail, uuid: lease.uuid });
  });

  it("should return 200 and get leases by user email", async () => {
    const userEmail = "test@example.com";
    const leases = [
      generateSchemaData(MonitoredLeaseSchema.omit({ meta: true }), {
        userEmail,
      }),
      generateSchemaData(PendingLeaseSchema.omit({ meta: true }), {
        userEmail,
      }),
      generateSchemaData(PendingLeaseSchema.omit({ meta: true })),
    ];

    await Promise.all(
      leases.map(async (lease) => {
        await leaseStore.create(lease);
      }),
    );

    try {
      await retryAsync(
        async () => {
          const response = await fetch(
            `${apiBaseUrl}/leases?userEmail=${userEmail}`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${token}`,
                "User-Agent": userAgentHeader,
              },
            },
          );

          const jsonResponseBody: any = await response.json();

          expect(response.status).toBe(200);
          expect(jsonResponseBody.data.result).toEqual(
            expect.arrayContaining(
              leases
                .filter((lease) => lease.userEmail == userEmail)
                .map((lease) => expect.objectContaining(lease)),
            ),
          );
        },
        { delay: 1_000, maxTry: 5 },
      );
    } finally {
      await Promise.all(
        leases.map(async (lease) => {
          await leaseStore.delete({
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          });
        }),
      );
    }
  });

  it("should return 201 and create a new lease", async () => {
    const leaseTemplate = await leaseTemplateStore.create(
      generateSchemaData(LeaseTemplateSchema.omit({ meta: true }), {
        requiresApproval: true,
      }),
    );

    const response = await fetch(`${apiBaseUrl}/leases`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": userAgentHeader,
      },
      body: JSON.stringify({
        leaseTemplateUuid: leaseTemplate.uuid,
      }),
    });

    const jsonResponseBody: any = await response.json();

    expect(response.status).toBe(201);
    expect(jsonResponseBody.data).toMatchObject({
      userEmail: testIsbUser.email,
      uuid: expect.any(String),
      originalLeaseTemplateUuid: leaseTemplate.uuid,
      originalLeaseTemplateName: leaseTemplate.name,
      leaseDurationInHours: leaseTemplate.leaseDurationInHours,
      status: "PendingApproval",
      approvedBy: null,
      awsAccountId: null,
      totalCostAccrued: 0,
      maxSpend: leaseTemplate.maxSpend,
      budgetThresholds: leaseTemplate.budgetThresholds,
      durationThresholds: leaseTemplate.durationThresholds,
    } as any as Lease);

    await leaseStore.delete({
      userEmail: jsonResponseBody.data.userEmail,
      uuid: jsonResponseBody.data.uuid,
    });
    await leaseTemplateStore.delete(leaseTemplate.uuid);
  });

  it("should return 200 and get lease by id", async () => {
    const leaseKey = generateSchemaData(LeaseKeySchema);
    const leaseId = base64EncodeCompositeKey(leaseKey);
    const lease = generateSchemaData(
      PendingLeaseSchema.omit({ meta: true }),
      leaseKey,
    );
    const newItem = await leaseStore.create(lease);

    const expectedLeaseResponse = {
      ...newItem,
      leaseId,
    };

    const response = await fetch(`${apiBaseUrl}/leases/${leaseId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgentHeader,
      },
    });

    const jsonResponseBody: any = await response.json();

    expect(response.status).toBe(200);
    expect(jsonResponseBody.data).toEqual(expectedLeaseResponse);

    await leaseStore.delete(leaseKey);
  });

  it("should return 200 and patch an existing lease", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema.omit({ meta: true }));
    await leaseStore.create(lease);

    const leaseId = Buffer.from(
      JSON.stringify({ userEmail: lease.userEmail, uuid: lease.uuid }),
      "utf8",
    ).toString("base64");

    const updatedLeaseTerms = generateSchemaData(
      MonitoredLeaseSchema.pick({
        maxSpend: true,
        budgetThresholds: true,
        expirationDate: true,
        durationThresholds: true,
      }),
    );

    const response = await fetch(`${apiBaseUrl}/leases/${leaseId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": userAgentHeader,
      },
      body: JSON.stringify(updatedLeaseTerms),
    });

    const jsonResponseBody: any = await response.json();

    expect(response.status).toBe(200);
    expect(jsonResponseBody.data).toMatchObject(updatedLeaseTerms);

    await leaseStore.delete({ userEmail: lease.userEmail, uuid: lease.uuid });
  });
});
