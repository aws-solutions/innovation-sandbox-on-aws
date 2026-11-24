// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import {
  LeaseSpendRateThresholdBreachedAlert,
  LeaseSpendRateThresholdTriggeredEventSchema,
} from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import {
  isSubscribedEmailEvent,
  SubscribedEmailEvents,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events.js";
import { SubscribableLogSchema } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";

const fullDetail = {
  leaseId: {
    userEmail: "someone@example.com",
    uuid: "750e8400-e29b-41d4-a716-446655440002",
  },
  accountId: "123456789012",
  rateBasis: "HOURLY",
  thresholdRate: 12,
  measuredRate: 14.5,
  budget: 200,
  totalSpend: 60,
  predictedCost: 120,
  hoursToBudgetExhaustion: 9.6,
  lastReportedAt: "2026-08-11T10:00:00.000Z",
  insight: {
    kind: "COMPOSITION",
    service: "Amazon Bedrock",
    amount: 40,
    shareOfComparedSpend: 0.66,
  },
} as const;

describe("LeaseSpendRateThresholdBreachedAlert", () => {
  test("has the LeaseSpendRateThresholdAlert detail type", () => {
    expect(EventDetailTypes.LeaseSpendRateThresholdBreachedAlert).toBe(
      "LeaseSpendRateThresholdAlert",
    );
    expect(
      new LeaseSpendRateThresholdBreachedAlert(fullDetail).DetailType,
    ).toBe("LeaseSpendRateThresholdAlert");
  });

  test("is a subscribed email event", () => {
    expect(SubscribedEmailEvents).toContain(
      EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
    );
    expect(isSubscribedEmailEvent("LeaseSpendRateThresholdAlert")).toBe(true);
  });

  describe("parse", () => {
    test.each([
      ["a full HOURLY detail", fullDetail],
      [
        "the required fields alone on a DAILY basis, at a zero measured rate",
        {
          leaseId: fullDetail.leaseId,
          accountId: fullDetail.accountId,
          rateBasis: "DAILY",
          thresholdRate: 100,
          measuredRate: 0,
          totalSpend: 0,
        },
      ],
      [
        "null projection and insight figures",
        {
          ...fullDetail,
          predictedCost: null,
          hoursToBudgetExhaustion: null,
          insight: null,
        },
      ],
      [
        "the token poll's countdown rate and unbilled Bedrock usage",
        {
          ...fullDetail,
          countdownRate: 133.2,
          countdownRateSource: "DAILY",
          unbilledBedrockTokenCost: 5.45,
        },
      ],
      [
        "null countdown and unbilled figures",
        {
          ...fullDetail,
          countdownRate: null,
          countdownRateSource: null,
          unbilledBedrockTokenCost: null,
        },
      ],
    ])("accepts %s", (_label, detail) => {
      expect(LeaseSpendRateThresholdTriggeredEventSchema.parse(detail)).toEqual(
        detail,
      );
      expect(LeaseSpendRateThresholdBreachedAlert.parse(detail).Detail).toEqual(
        detail,
      );
    });

    test("strips unknown keys rather than rejecting them", () => {
      const alert = LeaseSpendRateThresholdBreachedAlert.parse({
        ...fullDetail,
        leaseUuid: fullDetail.leaseId.uuid,
        sk: "BREACH#2026-08-11T11:00:00.000Z",
        triggeredBy: "RATE",
        thresholdRateBasis: "HOURLY",
        rateAtFire: 14.5,
        budgetThresholdTriggered: 70,
        // The dollar alert's projection-rate fields are not rate-native.
        rate: 3.5,
        rateSource: "HOURLY",
      });
      expect(alert.Detail).toEqual(fullDetail);
    });

    test.each([
      ["a missing rateBasis", { rateBasis: undefined }],
      ["a missing thresholdRate", { thresholdRate: undefined }],
      ["a missing measuredRate", { measuredRate: undefined }],
      ["a missing totalSpend", { totalSpend: undefined }],
      ["a zero thresholdRate", { thresholdRate: 0 }],
      ["a negative thresholdRate", { thresholdRate: -5 }],
      ["a negative measuredRate", { measuredRate: -0.01 }],
      ["an unknown rateBasis", { rateBasis: "WEEKLY" }],
      ["an unknown countdownRateSource", { countdownRateSource: "WEEKLY" }],
      ["a non-numeric countdownRate", { countdownRate: "fast" }],
      [
        "a non-numeric unbilledBedrockTokenCost",
        { unbilledBedrockTokenCost: "5.45" },
      ],
    ])("rejects %s", (_label, override) => {
      expect(() =>
        LeaseSpendRateThresholdBreachedAlert.parse({
          ...fullDetail,
          ...override,
        }),
      ).toThrow();
    });
  });

  describe("constructor", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    const invalid = {
      ...fullDetail,
      thresholdRate: 0,
      leaseUuid: fullDetail.leaseId.uuid,
      sk: "BREACH#2026-08-11T11:00:00.000Z",
      evaluatedSpendAtFire: 81.500001,
    };
    const construct = () =>
      new LeaseSpendRateThresholdBreachedAlert(
        invalid as unknown as ConstructorParameters<
          typeof LeaseSpendRateThresholdBreachedAlert
        >[0],
      );

    test("projects an invalid detail to the modelled keys, unrepaired", () => {
      expect(construct().Detail).toEqual({ ...fullDetail, thresholdRate: 0 });
    });

    test("strips unknown keys from a valid detail without warning", () => {
      const alert = new LeaseSpendRateThresholdBreachedAlert({
        ...fullDetail,
        sk: "BREACH#2026-08-11T11:00:00.000Z",
      } as unknown as ConstructorParameters<
        typeof LeaseSpendRateThresholdBreachedAlert
      >[0]);
      expect(alert.Detail).toEqual(fullDetail);
      expect(warn).not.toHaveBeenCalled();
    });

    test("does not throw on an invalid detail but logs a subscribable warning naming the failing paths", () => {
      // The producer runs inside the monitoring scan, so a throw here would
      // suppress the whole scan; rejection belongs to the consumer's parse.
      expect(construct).not.toThrow();

      expect(warn).toHaveBeenCalledWith(
        `${LogPatterns.DataValidationWarning.pattern}: emitting an invalid ${EventDetailTypes.LeaseSpendRateThresholdBreachedAlert} detail`,
        expect.objectContaining({
          logDetailType: "InvalidEventDetailEmitted",
          eventDetailType:
            EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
          invalidPaths: ["thresholdRate"],
        }),
      );
      expect(() =>
        SubscribableLogSchema.parse(warn.mock.calls[0]![1]),
      ).not.toThrow();
    });
  });
});
