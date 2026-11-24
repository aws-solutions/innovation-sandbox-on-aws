// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { orchestratorPrompt } from "@amzn/innovation-sandbox-agent-runtime/prompts.js";

describe("orchestratorPrompt", () => {
  const singleSpaced = (text: string) => text.replace(/\s+/g, " ");

  it("tells a memory-on agent that older messages may be missing and to search memory", () => {
    const prompt = singleSpaced(
      orchestratorPrompt({ regions: ["us-east-1"], memoryEnabled: true }),
    );

    expect(prompt).toContain(
      "Older messages from this lease may be missing from the conversation. When the user refers to something you don't see, call `search_memory` first instead of asking again.",
    );
    expect(prompt).not.toContain(
      "Earlier sessions on this lease are not in the conversation",
    );
  });
  it("asks for long results to be summarized while still quoting exact identifiers", () => {
    const prompt = orchestratorPrompt({ regions: ["us-east-1"] });

    expect(prompt).toContain(
      "When a result is long, summarize it or group related items instead of listing every item.",
    );
    expect(prompt).toContain(
      "Quote the specific resource\nidentifiers you found rather than paraphrasing them.",
    );
  });
});
