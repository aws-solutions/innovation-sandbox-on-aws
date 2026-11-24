// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  InterruptError,
  TextBlock,
  type Tool,
  type ToolContext,
  ToolResultBlock,
  ToolResultContent,
  type ToolStreamGenerator,
} from "@strands-agents/sdk";

import {
  type GuardrailScreeningEnv,
  screenUserText,
} from "@amzn/innovation-sandbox-agent-runtime/guardrail-screening.js";

/**
 * Longest tool output screened and kept. Fits one ApplyGuardrail request in
 * every Region and one `retrieve_context` page.
 */
export const TOOL_OUTPUT_MAX_CHARS = 20_000;

/** Shown to the model in place of tool output the guardrail blocked. */
export const TOOL_OUTPUT_BLOCKED_TEXT =
  "The tool output was withheld by the content safety guardrail.";

/** Shown to the model in place of tool output with images, video, or documents. */
export const TOOL_OUTPUT_UNSCREENABLE_TEXT =
  "The tool output was withheld because it contains content the safety check can't review.";

/** Every status a note may name. */
export const TOOL_RESULT_STATUSES = [
  "success",
  "error",
  "confirmation_required",
] as const;

export type ToolResultStatus = (typeof TOOL_RESULT_STATUSES)[number];

/**
 * Tool-specific text for the model. Only `resultStatus` gets the unscreened
 * result, and it returns a fixed status; the notes get only that status.
 */
export interface ToolOutputNotes {
  resultStatus(result: ToolResultBlock): ToolResultStatus;
  screeningFailed(status: ToolResultStatus): string;
  outputBlocked(status: ToolResultStatus): string;
  /** How to see the rest of output that was cut. */
  narrowCut: string;
}

export const DEFAULT_TOOL_OUTPUT_NOTES: ToolOutputNotes = {
  resultStatus: (result) => result.status,
  screeningFailed: () =>
    "The tool's result can't be shown because the safety check that reviews tool output failed to run. " +
    "Tell the user you couldn't read the result, and ask whether they want you to try again.",
  outputBlocked: () => TOOL_OUTPUT_BLOCKED_TEXT,
  narrowCut: "Ask for a smaller part to see the rest.",
};

/**
 * Screens a tool result before the model sees it; the model-call guardrail
 * never checks tool output. Output is cut to TOOL_OUTPUT_MAX_CHARS first, so
 * unscreened text never reaches the model or `retrieve_context`. Returns
 * `result` itself when nothing needs to change.
 */
export async function screenToolResult(
  result: ToolResultBlock,
  toolName: string,
  env: GuardrailScreeningEnv,
  notes: ToolOutputNotes,
): Promise<ToolResultBlock> {
  const { text: fullText, unscreenableTypes } = readToolResult(result.content);
  if (unscreenableTypes.length > 0) {
    console.warn("Tool output withheld: content can't be screened", {
      toolName,
      blockTypes: unscreenableTypes,
    });
    return replaceToolResultText(
      result,
      "error",
      TOOL_OUTPUT_UNSCREENABLE_TEXT,
    );
  }
  if (fullText.length === 0) return result;
  const isCut = fullText.length > TOOL_OUTPUT_MAX_CHARS;
  const text = isCut ? fullText.slice(0, TOOL_OUTPUT_MAX_CHARS) : fullText;

  let screened: Awaited<ReturnType<typeof screenUserText>>;
  try {
    screened = await screenUserText(text, env);
  } catch (err) {
    // Any failure (throttling, timeout, access) withholds the output.
    console.warn("Tool output screening failed", {
      toolName,
      characters: text.length,
      name: err instanceof Error ? err.name : typeof err,
    });
    return replaceToolResultText(
      result,
      "error",
      notes.screeningFailed(notes.resultStatus(result)),
    );
  }
  if (screened.blocked) {
    console.warn("Tool output blocked by the guardrail", {
      toolName,
      characters: text.length,
      blockedBy: screened.blockedBy,
    });
    return replaceToolResultText(
      result,
      result.status,
      notes.outputBlocked(notes.resultStatus(result)),
    );
  }
  if (!isCut && screened.text === text) return result;
  return replaceToolResultText(
    result,
    result.status,
    isCut
      ? screened.text + cutNote(fullText.length, notes.narrowCut)
      : screened.text,
  );
}

/**
 * Wraps `tool` so its `stream()` returns screened output. Strands records the
 * returned result on the tool span before any AfterToolCallEvent hook runs,
 * so screening must happen inside the tool for the span to hold screened text.
 */
export function withScreenedOutput(
  tool: Tool,
  env: GuardrailScreeningEnv,
  notes: ToolOutputNotes,
): Tool {
  return {
    name: tool.name,
    description: tool.description,
    toolSpec: tool.toolSpec,
    async *stream(toolContext: ToolContext): ToolStreamGenerator {
      const { name, toolUseId } = toolContext.toolUse;
      let result: ToolResultBlock;
      try {
        result = yield* tool.stream(toolContext);
      } catch (err) {
        if (err instanceof InterruptError) throw err;
        // Same text Strands would build from the thrown error, screened.
        result = new ToolResultBlock({
          toolUseId,
          status: "error",
          content: [
            new TextBlock(err instanceof Error ? err.message : String(err)),
          ],
        });
      }
      const screened = await screenToolResult(result, name, env, notes);
      // The span records `error.message` unscreened, so never pass it on.
      return screened.error === undefined
        ? screened
        : new ToolResultBlock({
            toolUseId: screened.toolUseId,
            status: screened.status,
            content: screened.content,
          });
    },
  };
}

function cutNote(fullLength: number, narrowCut: string): string {
  return `\n\n[Output cut at ${TOOL_OUTPUT_MAX_CHARS.toLocaleString("en-US")} of ${fullLength.toLocaleString("en-US")} characters. Tell the user the result is incomplete. ${narrowCut}]`;
}

/** Text and JSON content as the model reads it, and the block types it can't read. */
function readToolResult(content: ToolResultContent[]): {
  text: string;
  unscreenableTypes: ToolResultContent["type"][];
} {
  const texts: string[] = [];
  const unscreenableTypes = new Set<ToolResultContent["type"]>();
  for (const block of content) {
    if (block.type === "textBlock") texts.push(block.text);
    else if (block.type === "jsonBlock") texts.push(JSON.stringify(block.json));
    else unscreenableTypes.add(block.type);
  }
  return {
    text: texts.filter((text) => text.length > 0).join("\n"),
    unscreenableTypes: [...unscreenableTypes],
  };
}

function replaceToolResultText(
  result: ToolResultBlock,
  status: ToolResultBlock["status"],
  text: string,
): ToolResultBlock {
  return new ToolResultBlock({
    toolUseId: result.toolUseId,
    status,
    content: [new TextBlock(text)],
  });
}
