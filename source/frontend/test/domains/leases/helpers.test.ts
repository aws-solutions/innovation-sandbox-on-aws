// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  ExpiredLease,
  Lease,
  MonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { leaseExpirySortingComparator } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";

describe("leaseExpirySortingComparator", () => {
  const now = DateTime.now();

  it("should sort monitored leases by expirationDate chronologically", () => {
    const earlier = createActiveLease({
      expirationDate: now.plus({ days: 1 }).toISO()!,
    });
    const later = createActiveLease({
      expirationDate: now.plus({ days: 30 }).toISO()!,
    });

    const leases: MonitoredLease[] = [later, earlier];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(earlier);
    expect(leases[1]).toBe(later);
  });

  it("should sort expired leases by endDate chronologically", () => {
    const earlier = createExpiredLease({
      endDate: now.minus({ days: 30 }).toISO()!,
    });
    const later = createExpiredLease({
      endDate: now.minus({ days: 1 }).toISO()!,
    });

    const leases: ExpiredLease[] = [later, earlier];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(earlier);
    expect(leases[1]).toBe(later);
  });

  it("should sort pending leases by durationInHours", () => {
    const short = createPendingLease({ leaseDurationInHours: 2 });
    const long = createPendingLease({ leaseDurationInHours: 48 });

    const leases: Lease[] = [long, short];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(short);
    expect(leases[1]).toBe(long);
  });

  it("should sort monitored leases before pending leases when expiry is sooner", () => {
    const active = createActiveLease({
      expirationDate: now.plus({ hours: 1 }).toISO()!,
    });
    const pending = createPendingLease({ leaseDurationInHours: 48 });

    const leases: Lease[] = [pending, active];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(active);
    expect(leases[1]).toBe(pending);
  });

  it("should sort expired leases before pending leases", () => {
    const expired = createExpiredLease({
      endDate: now.minus({ days: 7 }).toISO()!,
    });
    const pending = createPendingLease({ leaseDurationInHours: 1 });

    const leases: Lease[] = [pending, expired];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(expired);
    expect(leases[1]).toBe(pending);
  });

  it("should handle mixed lease states and sort correctly", () => {
    const expired = createExpiredLease({
      endDate: now.minus({ days: 30 }).toISO()!,
    });
    const active = createActiveLease({
      expirationDate: now.plus({ days: 7 }).toISO()!,
    });
    const pending = createPendingLease({ leaseDurationInHours: 720 });

    const leases: Lease[] = [pending, active, expired];
    leases.sort(leaseExpirySortingComparator);

    // expired (past) < active (now+7d) < pending (now+720h ≈ 30d)
    expect(leases[0]).toBe(expired);
    expect(leases[1]).toBe(active);
    expect(leases[2]).toBe(pending);
  });

  it("should return 0 for two leases with the same date", () => {
    const date = now.plus({ days: 5 }).toISO()!;
    const a = createActiveLease({ expirationDate: date });
    const b = createActiveLease({ expirationDate: date });

    expect(leaseExpirySortingComparator(a, b)).toBe(0);
  });
});
