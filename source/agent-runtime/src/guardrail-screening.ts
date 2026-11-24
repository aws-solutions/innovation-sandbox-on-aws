// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ApplyGuardrailCommand,
  type ApplyGuardrailCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";

import { AgentRuntimeEnvironment } from "@amzn/innovation-sandbox-agent-runtime/environment.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";

/** Shown when the guardrail blocks but returns no blocked-input message. */
const FALLBACK_BLOCKED_MESSAGE =
  "Your request was blocked by the content safety guardrail. Please rephrase and try again.";

/** A guardrail policy entry that blocked. Never carries the matched text. */
export interface GuardrailBlock {
  type?: string;
  confidence?: string;
}

export type ScreenedUserText =
  | { blocked: false; text: string }
  /** `message` is the guardrail's blocked-input message, not the user's text. */
  | { blocked: true; message: string; blockedBy: GuardrailBlock[] };

export type GuardrailScreeningEnv = Pick<
  AgentRuntimeEnvironment,
  "GUARDRAIL_ID" | "GUARDRAIL_VERSION" | "USER_AGENT_EXTRA"
>;
/**
 * Screens text with the agent's guardrail as input. Throws if the call fails
 * or masks without returning text, so unscreened text never passes.
 */
export async function screenUserText(
  text: string,
  env: GuardrailScreeningEnv,
): Promise<ScreenedUserText> {
  const response = await IsbClients.bedrockRuntime(env).send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: env.GUARDRAIL_ID,
      guardrailVersion: env.GUARDRAIL_VERSION,
      source: "INPUT",
      content: [{ text: { text } }],
    }),
  );
  if (response.action !== "GUARDRAIL_INTERVENED") {
    return { blocked: false, text };
  }
  const outputText = (response.outputs ?? [])
    .map((output) => output.text ?? "")
    .join("");
  const blockedBy = blockingEntries(response);
  if (blockedBy.length > 0) {
    return {
      blocked: true,
      message: outputText || FALLBACK_BLOCKED_MESSAGE,
      blockedBy,
    };
  }
  if (!outputText) {
    throw new Error(
      "Guardrail intervened without returning masked text; refusing to pass the message on unmasked.",
    );
  }
  return { blocked: false, text: outputText };
}

/**
 * Policy entries in the assessment that blocked rather than masked. Keeps only
 * `type` and `confidence`: PII entries also carry the matched text.
 */
function blockingEntries(
  response: ApplyGuardrailCommandOutput,
): GuardrailBlock[] {
  const found: GuardrailBlock[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== "object") return;
    const entry = value as {
      action?: unknown;
      type?: unknown;
      confidence?: unknown;
    };
    if (entry.action === "BLOCKED") {
      found.push({
        ...(typeof entry.type === "string" && { type: entry.type }),
        ...(typeof entry.confidence === "string" && {
          confidence: entry.confidence,
        }),
      });
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(response.assessments);
  return found;
}
