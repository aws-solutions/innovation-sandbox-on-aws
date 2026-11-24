// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  getMarkdownSegments,
  MarkdownContent,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/MarkdownContent";

describe("MarkdownContent", () => {
  it("renders a valid multiline GFM table", () => {
    render(
      <MarkdownContent
        content={"| Service | Status |\n| --- | --- |\n| S3 | Enabled |"}
      />,
    );

    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "Service" }),
    ).toBeVisible();
    expect(within(table).getByRole("cell", { name: "Enabled" })).toBeVisible();
  });

  it("renders table rows when an agent returns the table on one line", () => {
    render(
      <MarkdownContent
        content={
          "| Service | Status | | --- | --- | | S3 | Enabled | | Lambda | Pending |"
        }
      />,
    );

    const table = screen.getByRole("table");
    expect(within(table).getByRole("cell", { name: "Enabled" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "Pending" })).toBeVisible();
  });

  it("preserves empty cells in one-line table rows", () => {
    render(
      <MarkdownContent
        content={
          "| Service | Status | | --- | --- | | S3 | | | Lambda | Pending |"
        }
      />,
    );

    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "Service" }),
    ).toBeVisible();
    expect(within(table).getByRole("cell", { name: "S3" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "Lambda" })).toBeVisible();
    expect(within(table).getByRole("cell", { name: "Pending" })).toBeVisible();
    expect(within(table).getAllByRole("cell")).toHaveLength(4);
  });

  it("keeps ordinary prose containing pipes as non-table text", () => {
    const content = "Use pipe-delimited values like alpha | beta in prose.";
    render(<MarkdownContent content={content} />);

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(content)).toBeVisible();
  });

  it("keeps malformed one-line table-like input visible as non-table text", () => {
    const content =
      "| Service | Status | | --- | --- | | S3 | Enabled | Extra |";
    render(<MarkdownContent content={content} />);

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(content)).toBeVisible();
  });

  it("renders fenced code in an accessible CodeView outside a pre element", () => {
    render(
      <MarkdownContent content={"```typescript\nconst answer = 42;\n```"} />,
    );

    const codeView = screen.getByLabelText("typescript code snippet");
    expect(codeView).toBeVisible();
    expect(codeView.closest("pre")).toBeNull();
  });

  it.each([
    ["cpp", "int main() { return 0; }"],
    ["c++", "int main() { return 0; }"],
    ["csharp", "public class Foo { }"],
    ["c#", "public class Foo { }"],
    ["css", "body { color: red; }"],
    ["go", "func main() { return }"],
    ["html", "<div class='a'></div>"],
    ["java", "public class Foo { }"],
    ["javascript", "const answer = 42;"],
    ["json", '{ "answer": 42 }'],
    ["kotlin", "fun main() { val x = 1 }"],
    ["markdown", "# Heading"],
    ["php", "<?php echo 'hi'; ?>"],
    ["python", "def main(): return 1"],
    ["ruby", "def main; end"],
    ["rust", "fn main() { let x = 1; }"],
    ["bash", "echo hello"],
    ["typescript", "const answer: number = 42;"],
    ["xml", "<root attr='a'/>"],
    ["yaml", "key: value"],
  ])("highlights fenced %s code", (language, code) => {
    render(
      <MarkdownContent content={"```" + language + "\n" + code + "\n```"} />,
    );

    const codeView = screen.getByLabelText(`${language} code snippet`);
    expect(codeView.querySelector("[class*='ace_']")).not.toBeNull();
  });

  it("renders unknown languages as plain code", () => {
    render(<MarkdownContent content={"```cobol\nDISPLAY 'HI'.\n```"} />);

    const codeView = screen.getByLabelText("cobol code snippet");
    expect(codeView.querySelector("[class*='ace_']")).toBeNull();
    expect(codeView).toHaveTextContent("DISPLAY 'HI'.");
  });
  it.each(["__proto__", "constructor"])(
    "renders a %s fence as plain code without crashing",
    (language) => {
      render(<MarkdownContent content={"```" + language + "\nhi\n```"} />);
      const codeView = screen.getByLabelText(`${language} code snippet`);
      expect(codeView.querySelector("[class*='ace_']")).toBeNull();
      expect(codeView).toHaveTextContent("hi");
    },
  );

  it("keeps inline code as a code element", () => {
    render(<MarkdownContent content="Run `npm run build` before release." />);

    const inlineCode = screen.getByText("npm run build");
    expect(inlineCode.tagName).toBe("CODE");
    expect(screen.queryByLabelText("Code snippet")).not.toBeInTheDocument();
  });
});

describe("getMarkdownSegments", () => {
  it("returns no segments for empty or whitespace-only content", () => {
    expect(getMarkdownSegments("")).toEqual([]);
    expect(getMarkdownSegments(" \n\t ")).toEqual([]);
  });

  it("preserves leading and trailing prose around a code artifact", () => {
    expect(
      getMarkdownSegments(
        "Before the command.\n\n```bash\nnpm run build\n```\n\nAfter the command.",
      ),
    ).toEqual([
      { kind: "text", content: "Before the command." },
      { kind: "code", content: "```bash\nnpm run build\n```" },
      { kind: "text", content: "After the command." },
    ]);
  });

  it("normalizes a valid one-line table in the table segment", () => {
    expect(
      getMarkdownSegments(
        "| Service | Status | | --- | --- | | S3 | Enabled | | Lambda | Pending |",
      ),
    ).toEqual([
      {
        kind: "table",
        content:
          "| Service | Status |\n| --- | --- |\n| S3 | Enabled |\n| Lambda | Pending |",
      },
    ]);
  });

  it("preserves document order while separating code blocks and tables", () => {
    expect(
      getMarkdownSegments(
        "Intro with `inline code`.\n\n```typescript\nconst answer = 42;\n```\n\n| Service | Status |\n| --- | --- |\n| S3 | Ready |",
      ),
    ).toEqual([
      { kind: "text", content: "Intro with `inline code`." },
      {
        kind: "code",
        content: "```typescript\nconst answer = 42;\n```",
      },
      {
        kind: "table",
        content: "| Service | Status |\n| --- | --- |\n| S3 | Ready |",
      },
    ]);
  });
});
