// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  NotificationFailureContext,
  publish,
} from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/notification-publishing.service.js";
import {
  NOTIFICATION_SCHEMA_VERSION,
  NotificationPublishMessage,
} from "@amzn/innovation-sandbox-commons/isb-services/notification-publishing/notification-publishing.types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  InternalErrorException,
  PublishCommand,
  PublishCommandInput,
  SNSClient,
} from "@aws-sdk/client-sns";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

const topicArn = "arn:aws:sns:us-east-1:123456789012:isb-test-notifications";
// maxAttempts matches IsbClients.sns's own client configuration, so the
// retry-then-success test below exercises the SDK's real retry middleware.
const retryingSnsClient = new SNSClient({ maxAttempts: 3 });
const snsMock = mockClient(retryingSnsClient);

/** Narrows the mock's ServiceInputTypes union back to PublishCommandInput, the only command this test file sends. */
function publishedInput(callIndex: number): PublishCommandInput {
  return snsMock.call(callIndex).args[0].input as PublishCommandInput;
}

function baseMessage(
  overrides: Partial<NotificationPublishMessage> = {},
): NotificationPublishMessage {
  return {
    subject: "Lease Approved - Innovation Sandbox",
    textBody: "Your lease request has been approved.",
    htmlBody: "<p>Your lease request has been approved.</p>",
    notificationType: "LeaseApproved",
    recipientPersona: "user",
    recipientEmails: ["developer@example.com"],
    ...overrides,
  };
}

function failureContext(
  overrides: Partial<NotificationFailureContext> = {},
): NotificationFailureContext {
  return {
    isbNamespace: "test-isb",
    notificationType: "LeaseApproved",
    ...overrides,
  };
}

describe("notification-publishing.service", () => {
  beforeEach(() => {
    snsMock.reset();
  });

  describe("publish", () => {
    it("publishes successfully with the topic ARN, subject, and message body", async () => {
      snsMock.on(PublishCommand).resolves({ MessageId: "message-id-1" });
      const logger = new Logger();

      await publish(baseMessage(), failureContext(), {
        snsClient: retryingSnsClient,
        topicArn,
        logger,
      });

      expect(snsMock.calls()).toHaveLength(1);
      const input = publishedInput(0);
      expect(input.TopicArn).toEqual(topicArn);
      expect(input.Subject).toEqual("Lease Approved - Innovation Sandbox");
      expect(JSON.parse(input.Message!)).toEqual({
        subject: "Lease Approved - Innovation Sandbox",
        body: "Your lease request has been approved.",
        htmlBody: "<p>Your lease request has been approved.</p>",
      });
    });

    it("stamps every published message with the schemaVersion attribute as an SNS String-type attribute with the currently designed value", async () => {
      snsMock.on(PublishCommand).resolves({ MessageId: "message-id-2" });
      const logger = new Logger();

      await publish(baseMessage(), failureContext(), {
        snsClient: retryingSnsClient,
        topicArn,
        logger,
      });

      const attributes = publishedInput(0).MessageAttributes!;
      expect(attributes.schemaVersion).toEqual({
        DataType: "String",
        StringValue: NOTIFICATION_SCHEMA_VERSION,
      });
    });

    it.each([
      { recipientEmails: ["admin1@example.com"] },
      { recipientEmails: ["admin1@example.com", "admin2@example.com"] },
    ])(
      "publishes routing attributes for $recipientEmails",
      async ({ recipientEmails }) => {
        snsMock.on(PublishCommand).resolves({ MessageId: "message-id-3" });
        const logger = new Logger();

        await publish(
          baseMessage({
            notificationType: "LeaseApproved",
            recipientPersona: "manager",
            recipientEmails,
          }),
          failureContext(),
          { snsClient: retryingSnsClient, topicArn, logger },
        );

        const attributes = publishedInput(0).MessageAttributes!;
        expect(attributes.notificationType).toEqual({
          DataType: "String",
          StringValue: "LeaseApproved",
        });
        expect(attributes.recipientPersona).toEqual({
          DataType: "String",
          StringValue: "manager",
        });
        expect(attributes.recipientEmails).toEqual({
          DataType: "String.Array",
          StringValue: JSON.stringify(recipientEmails),
        });
      },
    );

    it("includes awsAccountId and leaseUuid as conditional attributes only when present on the message", async () => {
      snsMock.on(PublishCommand).resolves({ MessageId: "message-id-4" });
      const logger = new Logger();

      await publish(
        baseMessage({
          awsAccountId: "123456789012",
          leaseUuid: "b2c3d4e5-0000-0000-0000-000000000000",
        }),
        failureContext(),
        { snsClient: retryingSnsClient, topicArn, logger },
      );

      const attributes = publishedInput(0).MessageAttributes!;
      expect(attributes.awsAccountId).toEqual({
        DataType: "String",
        StringValue: "123456789012",
      });
      expect(attributes.leaseUuid).toEqual({
        DataType: "String",
        StringValue: "b2c3d4e5-0000-0000-0000-000000000000",
      });
    });

    it("omits awsAccountId and leaseUuid attributes when the message does not carry them", async () => {
      snsMock.on(PublishCommand).resolves({ MessageId: "message-id-5" });
      const logger = new Logger();

      await publish(baseMessage(), failureContext(), {
        snsClient: retryingSnsClient,
        topicArn,
        logger,
      });

      const attributes = publishedInput(0).MessageAttributes!;
      expect(attributes.awsAccountId).toBeUndefined();
      expect(attributes.leaseUuid).toBeUndefined();
    });

    it("normalizes a multi-line, over-length subject to a single line under SNS's 100-character limit", async () => {
      snsMock.on(PublishCommand).resolves({ MessageId: "message-id-6" });
      const logger = new Logger();
      const longSubject = `Line one\nLine two ${"x".repeat(120)}`;

      await publish(baseMessage({ subject: longSubject }), failureContext(), {
        snsClient: retryingSnsClient,
        topicArn,
        logger,
      });

      const sentSubject = publishedInput(0).Subject!;
      expect(sentSubject).not.toContain("\n");
      expect(sentSubject.length).toBeLessThanOrEqual(100);
    });

    describe("subject normalization", () => {
      /** Publishes `subject` and returns the `Subject` SNS actually received. */
      async function publishedSubject(subject: string): Promise<string> {
        snsMock.on(PublishCommand).resolves({ MessageId: "message-id-norm" });
        const logger = new Logger();

        await publish(baseMessage({ subject }), failureContext(), {
          snsClient: retryingSnsClient,
          topicArn,
          logger,
        });

        return publishedInput(snsMock.calls().length - 1).Subject!;
      }

      it("joins LF-separated lines with a single space", async () => {
        expect(await publishedSubject("Line one\nLine two")).toEqual(
          "Line one Line two",
        );
      });

      it("joins CRLF-separated lines with a single space, absorbing the trailing CR", async () => {
        expect(await publishedSubject("Line one\r\nLine two")).toEqual(
          "Line one Line two",
        );
      });

      it("collapses repeated blank lines between content into a single separator", async () => {
        expect(await publishedSubject("Line one\n\n\n\nLine two")).toEqual(
          "Line one Line two",
        );
      });

      it("strips Unicode and tab whitespace surrounding a newline", async () => {
        expect(
          await publishedSubject("Line one \t\u00A0\n\u00A0\t Line two"),
        ).toEqual("Line one Line two");
      });

      it("preserves internal same-line whitespace, including multiple spaces and tabs", async () => {
        expect(
          await publishedSubject("Line  one\twith\tinternal   spacing"),
        ).toEqual("Line  one\twith\tinternal   spacing");
      });

      it("preserves internal same-line whitespace on each line when joining multiple lines", async () => {
        expect(
          await publishedSubject(
            "internal   same-line   spacing\nsecond   line   spacing",
          ),
        ).toEqual("internal   same-line   spacing second   line   spacing");
      });

      it("omits the Subject property entirely when the input is an empty string", async () => {
        snsMock.on(PublishCommand).resolves({ MessageId: "message-id-norm" });
        const logger = new Logger();

        await publish(baseMessage({ subject: "" }), failureContext(), {
          snsClient: retryingSnsClient,
          topicArn,
          logger,
        });

        const input = publishedInput(snsMock.calls().length - 1);
        expect(input).not.toHaveProperty("Subject");
      });

      it("omits the Subject property entirely when the input normalizes to empty (whitespace/newlines only)", async () => {
        snsMock.on(PublishCommand).resolves({ MessageId: "message-id-norm" });
        const logger = new Logger();

        await publish(
          baseMessage({ subject: "   \n\t \n  " }),
          failureContext(),
          { snsClient: retryingSnsClient, topicArn, logger },
        );

        const input = publishedInput(snsMock.calls().length - 1);
        expect(input).not.toHaveProperty("Subject");
      });

      it("leaves a subject of exactly 99 characters unchanged", async () => {
        const subject = "a".repeat(99);
        expect(await publishedSubject(subject)).toEqual(subject);
      });

      it("leaves a subject of exactly 100 characters unchanged", async () => {
        const subject = "a".repeat(100);
        expect(await publishedSubject(subject)).toEqual(subject);
      });

      it("truncates a subject of exactly 101 characters to 100 characters", async () => {
        const subject = "a".repeat(101);
        const result = await publishedSubject(subject);
        expect(result.length).toEqual(100);
        expect(result).toEqual("a".repeat(100));
      });

      it("normalizes before truncating, so a newline collapsed below the limit is not cut mid-word", async () => {
        // Raw length is 101 (50 + 1 newline + 50), but the newline becomes a
        // single space, so the normalized length is exactly 101 -> truncates
        // to 100. This proves normalization runs before truncation: a naive
        // truncate-then-normalize on the raw string would cut inside the
        // second word.
        const subject = `${"a".repeat(50)}\n${"b".repeat(50)}`;
        const result = await publishedSubject(subject);
        expect(result).toEqual(`${"a".repeat(50)} ${"b".repeat(49)}`);
        expect(result.length).toEqual(100);
      });

      it("handles a large adversarial subject with no newlines without hanging, truncating to 100 characters", async () => {
        // 100,000 spaces and no newlines: the previous `\s*\n\s*` regex
        // backtracks quadratically on a long whitespace-only run and would
        // blow past Vitest's default test timeout at this size, while the
        // linear split/trim/filter implementation finishes near-instantly.
        // Completion within the default timeout is itself the regression
        // guard; no wall-clock assertion is needed. The normalized result is
        // empty, so Subject is omitted rather than sent as "".
        snsMock.on(PublishCommand).resolves({ MessageId: "message-id-norm" });
        const logger = new Logger();
        const subject = " ".repeat(100_000);

        await publish(baseMessage({ subject }), failureContext(), {
          snsClient: retryingSnsClient,
          topicArn,
          logger,
        });

        const input = publishedInput(snsMock.calls().length - 1);
        expect(input).not.toHaveProperty("Subject");
      });

      it("handles a large adversarial subject with many newlines without hanging, truncating to 100 characters", async () => {
        // 50,000 single-character lines join to "a a a ...": each separator
        // is one space per line break, so the normalized string is far
        // longer than 100 chars and gets truncated to exactly 100.
        const subject = Array.from({ length: 50_000 }, () => "a").join("\n");
        const result = await publishedSubject(subject);

        expect(result.length).toEqual(100);
        expect(result).toEqual("a ".repeat(50).slice(0, 100));
      });
    });

    it("delegates all retry behavior to the SNS client's own configuration, making exactly one send() call per publish attempt", async () => {
      // aws-sdk-client-mock replaces the client's terminal handler beneath
      // the retry middleware, so real retries aren't exercised here. This
      // test verifies instead that publish() itself makes exactly one
      // send() call and contains no application-level retry loop.
      snsMock.on(PublishCommand).resolves({ MessageId: "message-id-7" });
      const logger = new Logger();
      const errorSpy = vi.spyOn(logger, "error");

      await publish(baseMessage(), failureContext(), {
        snsClient: retryingSnsClient,
        topicArn,
        logger,
      });

      expect(snsMock.calls()).toHaveLength(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("never throws when the underlying SNS send fails, and emits exactly one NotificationFailed log with no message body", async () => {
      const permanentError = new InternalErrorException({
        message: "topic policy denies publish",
        $metadata: {},
      });
      snsMock.on(PublishCommand).rejects(permanentError);
      const logger = new Logger();
      const errorSpy = vi
        .spyOn(logger, "error")
        .mockImplementation(() => undefined);

      await expect(
        publish(
          baseMessage({
            recipientEmails: ["someone@example.com"],
          }),
          failureContext({
            leaseId: "lease-uuid-123",
            awsAccountId: "123456789012",
          }),
          { snsClient: retryingSnsClient, topicArn, logger },
        ),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [pattern, logPayload] = errorSpy.mock.calls[0]!;
      expect(pattern).toEqual(LogPatterns.NotificationFailed.pattern);
      const serializedPayload = JSON.stringify(logPayload);
      expect(logPayload).toMatchObject({
        notificationMetricType: "NotificationDeliveryFailed",
        isbNamespace: "test-isb",
        channel: "SNS",
        notificationType: "LeaseApproved",
        leaseId: "lease-uuid-123",
        awsAccountId: "123456789012",
        errorNames: ["InternalErrorException"],
      });
      expect(logPayload).not.toHaveProperty("errorMessage");
      expect(logPayload).not.toHaveProperty("logDetailType");
      expect(serializedPayload).not.toContain(permanentError.message);
      expect(serializedPayload).not.toContain("someone@example.com");
      expect(serializedPayload).not.toContain(baseMessage().textBody);
    });

    it("never throws when the underlying SNS client's send() throws synchronously (not a rejected promise), and still logs NotificationFailed with no PII", async () => {
      // props.snsClient.send() is invoked inside a `.then()` callback, so a
      // *synchronous* throw from send() -- as opposed to a promise it
      // returns that later rejects -- must still be caught by the
      // Promise.resolve().then().catch() chain rather than escaping as an
      // unhandled exception. mockImplementation's callback throwing (as
      // opposed to returning a rejected promise) is what exercises that
      // synchronous-throw path.
      const synchronousError = new Error("send() blew up synchronously");
      synchronousError.name = "X".repeat(300);
      const sendSpy = vi
        .spyOn(retryingSnsClient, "send")
        .mockImplementation(() => {
          throw synchronousError;
        });
      const logger = new Logger();
      const errorSpy = vi
        .spyOn(logger, "error")
        .mockImplementation(() => undefined);

      await expect(
        publish(
          baseMessage({
            recipientEmails: ["someone@example.com"],
          }),
          failureContext({
            leaseId: "lease-uuid-123",
            awsAccountId: "123456789012",
          }),
          { snsClient: retryingSnsClient, topicArn, logger },
        ),
      ).resolves.toBeUndefined();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [pattern, logPayload] = errorSpy.mock.calls[0]!;
      expect(pattern).toEqual(LogPatterns.NotificationFailed.pattern);
      expect(logPayload).toMatchObject({
        notificationMetricType: "NotificationDeliveryFailed",
        isbNamespace: "test-isb",
        channel: "SNS",
        notificationType: "LeaseApproved",
        leaseId: "lease-uuid-123",
        awsAccountId: "123456789012",
        errorNames: ["X".repeat(256)],
      });
      expect(logPayload).not.toHaveProperty("errorMessage");
      expect(logPayload).not.toHaveProperty("logDetailType");
      // The message body and recipientEmails carry recipient PII and must
      // never appear in the failure log line, even on this synchronous path.
      const serializedPayload = JSON.stringify(logPayload);
      expect(serializedPayload).not.toContain(synchronousError.message);
      expect(serializedPayload).not.toContain("someone@example.com");
      expect(serializedPayload).not.toContain(baseMessage().textBody);

      sendSpy.mockRestore();
    });

    it("never throws on a non-Error rejection or logs its raw value", async () => {
      // callsFake preserves a non-Error rejection for this branch.
      snsMock
        .on(PublishCommand)
        .callsFake(() => Promise.reject("topic policy denies publish"));
      const logger = new Logger();
      const errorSpy = vi
        .spyOn(logger, "error")
        .mockImplementation(() => undefined);

      await expect(
        publish(
          baseMessage({ recipientEmails: ["someone@example.com"] }),
          failureContext(),
          { snsClient: retryingSnsClient, topicArn, logger },
        ),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [pattern, logPayload] = errorSpy.mock.calls[0]!;
      expect(pattern).toEqual(LogPatterns.NotificationFailed.pattern);
      expect(logPayload).toMatchObject({
        notificationMetricType: "NotificationDeliveryFailed",
        isbNamespace: "test-isb",
        channel: "SNS",
        notificationType: "LeaseApproved",
        errorNames: [],
      });
      expect(logPayload).not.toHaveProperty("errorMessage");
      expect(logPayload).not.toHaveProperty("logDetailType");
      const serializedPayload = JSON.stringify(logPayload);
      expect(serializedPayload).not.toContain("topic policy denies publish");
      expect(serializedPayload).not.toContain("someone@example.com");
      expect(serializedPayload).not.toContain(baseMessage().textBody);
    });
  });
});
