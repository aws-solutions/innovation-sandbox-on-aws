// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { isToolResultMessage } from "@amzn/innovation-sandbox-agent-runtime/conversation.js";
import {
  isTransientModelError,
  modelErrorFrame,
} from "@amzn/innovation-sandbox-agent-runtime/model-errors.js";
import {
  AfterModelCallEvent,
  BeforeModelCallEvent,
  DefaultModelRetryStrategy,
  type LocalAgent,
  ModelRetryStrategy,
  ModelStreamUpdateEvent,
  type RetryDecision,
} from "@strands-agents/sdk";

const RETRY_DELAY_MS = 1_000;

/** New per agent, because each holds state for one agent. Passing a list replaces Strands' default, so it is listed to keep its in-stream throttling retry. */
export function modelRetryStrategies(): ModelRetryStrategy[] {
  return [new DefaultModelRetryStrategy(), new FirstCallModelRetryStrategy()];
}

/** A call after a command or after shown text isn't retried, so nothing runs or shows twice. */
export class FirstCallModelRetryStrategy extends ModelRetryStrategy {
  readonly name = "isb:first-call-model-retry";
  private callShowedText = false;
  private callStopReason: string | undefined;

  override initAgent(agent: LocalAgent): void {
    super.initAgent(agent);
    agent.addHook(BeforeModelCallEvent, () => {
      this.callShowedText = false;
      this.callStopReason = undefined;
    });
    agent.addHook(ModelStreamUpdateEvent, (event) => {
      if (event.event.type === "modelMessageStopEvent") {
        this.callStopReason = event.event.stopReason;
      } else if (
        event.event.type === "modelContentBlockDeltaEvent" &&
        event.event.delta.type === "textDelta"
      ) {
        this.callShowedText = true;
      }
    });
  }

  protected computeRetryDecision(event: AfterModelCallEvent): RetryDecision {
    const latestMessage = event.agent.messages.at(-1);
    const retry =
      event.attemptCount === 1 &&
      !this.callShowedText &&
      latestMessage !== undefined &&
      !isToolResultMessage(latestMessage) &&
      isTransientModelError(event.error, this.callStopReason);
    if (!retry) return { retry: false };
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "AgentModelCallRetried",
        code: modelErrorFrame(event.error, this.callStopReason)?.code,
        stopReason: this.callStopReason,
        attemptCount: event.attemptCount,
        errorName: event.error?.name,
        errorMessage: event.error?.message,
      }),
    );
    return { retry: true, waitMs: RETRY_DELAY_MS };
  }
}
