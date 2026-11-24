// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { screenUserText } from "@amzn/innovation-sandbox-agent-runtime/guardrail-screening.js";

const bedrock = mockClient(BedrockRuntimeClient);

const env = {
  GUARDRAIL_ID: "gr-1",
  GUARDRAIL_VERSION: "1",
  USER_AGENT_EXTRA: "test-agent",
};

const TEXT =
  "My .env has AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

describe("screenUserText", () => {
  beforeEach(() => bedrock.reset());

  it("returns the guardrail's masked text when it anonymizes", async () => {
    bedrock.on(ApplyGuardrailCommand).resolves({
      action: "GUARDRAIL_INTERVENED",
      outputs: [{ text: "My .env has AWS_SECRET_ACCESS_KEY={AWS_SECRET_KEY}" }],
      assessments: [
        {
          sensitiveInformationPolicy: {
            piiEntities: [
              {
                type: "AWS_SECRET_KEY",
                match: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                action: "ANONYMIZED",
              },
            ],
            regexes: [],
          },
        },
      ],
    });

    expect(await screenUserText(TEXT, env)).toEqual({
      blocked: false,
      text: "My .env has AWS_SECRET_ACCESS_KEY={AWS_SECRET_KEY}",
    });
  });

  it("checks the text as model input with the agent's guardrail", async () => {
    bedrock.on(ApplyGuardrailCommand).resolves({ action: "NONE" });

    await screenUserText(TEXT, env);

    expect(
      bedrock.commandCalls(ApplyGuardrailCommand)[0]!.args[0].input,
    ).toEqual({
      guardrailIdentifier: "gr-1",
      guardrailVersion: "1",
      source: "INPUT",
      content: [{ text: { text: TEXT } }],
    });
  });

  it("returns the original text when the guardrail does not intervene", async () => {
    bedrock.on(ApplyGuardrailCommand).resolves({ action: "NONE", outputs: [] });

    expect(await screenUserText("list my buckets", env)).toEqual({
      blocked: false,
      text: "list my buckets",
    });
  });

  // A blocked response carries the blocked-input message, not the user's text
  // with secrets masked, so there is nothing safe to hand the agent.
  it("reports a block with the guardrail's message, never the user's text", async () => {
    bedrock.on(ApplyGuardrailCommand).resolves({
      action: "GUARDRAIL_INTERVENED",
      outputs: [{ text: "Your request was blocked." }],
      assessments: [
        {
          contentPolicy: {
            filters: [
              { type: "PROMPT_ATTACK", confidence: "HIGH", action: "BLOCKED" },
            ],
          },
          sensitiveInformationPolicy: {
            piiEntities: [
              {
                type: "AWS_SECRET_KEY",
                match: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                action: "ANONYMIZED",
              },
            ],
            regexes: [],
          },
        },
      ],
    });

    expect(await screenUserText(TEXT, env)).toEqual({
      blocked: true,
      message: "Your request was blocked.",
      // The masked PII entry, and its matched text, stay out of the result.
      blockedBy: [{ type: "PROMPT_ATTACK", confidence: "HIGH" }],
    });
  });

  it("throws rather than pass the original on when the guardrail masks but returns no text", async () => {
    bedrock.on(ApplyGuardrailCommand).resolves({
      action: "GUARDRAIL_INTERVENED",
      outputs: [],
      assessments: [
        {
          sensitiveInformationPolicy: {
            piiEntities: [
              {
                type: "AWS_SECRET_KEY",
                match: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                action: "ANONYMIZED",
              },
            ],
            regexes: [],
          },
        },
      ],
    });

    await expect(screenUserText(TEXT, env)).rejects.toThrow(
      "refusing to pass the message on unmasked",
    );
  });

  it("propagates a guardrail failure rather than passing the text unmasked", async () => {
    bedrock.on(ApplyGuardrailCommand).rejects(new Error("ThrottlingException"));

    await expect(screenUserText(TEXT, env)).rejects.toThrow(
      "ThrottlingException",
    );
  });
});
