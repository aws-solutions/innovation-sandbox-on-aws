// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import CodeView from "@cloudscape-design/code-view/code-view";
import cppHighlight from "@cloudscape-design/code-view/highlight/cpp";
import csharpHighlight from "@cloudscape-design/code-view/highlight/csharp";
import cssHighlight from "@cloudscape-design/code-view/highlight/css";
import goHighlight from "@cloudscape-design/code-view/highlight/go";
import htmlHighlight from "@cloudscape-design/code-view/highlight/html";
import javaHighlight from "@cloudscape-design/code-view/highlight/java";
import javascriptHighlight from "@cloudscape-design/code-view/highlight/javascript";
import jsonHighlight from "@cloudscape-design/code-view/highlight/json";
import kotlinHighlight from "@cloudscape-design/code-view/highlight/kotlin";
import markdownHighlight from "@cloudscape-design/code-view/highlight/markdown";
import phpHighlight from "@cloudscape-design/code-view/highlight/php";
import pythonHighlight from "@cloudscape-design/code-view/highlight/python";
import rubyHighlight from "@cloudscape-design/code-view/highlight/ruby";
import rustHighlight from "@cloudscape-design/code-view/highlight/rust";
import shHighlight from "@cloudscape-design/code-view/highlight/sh";
import typescriptHighlight from "@cloudscape-design/code-view/highlight/typescript";
import xmlHighlight from "@cloudscape-design/code-view/highlight/xml";
import yamlHighlight from "@cloudscape-design/code-view/highlight/yaml";
import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type MarkdownContentProps = {
  content: string;
};

type CodeElementProps = {
  className?: string;
  children?: ReactNode;
};

type CodeBlock = {
  content: string;
  language?: string;
};

// All Cloudscape CodeView highlighters, plus common fence aliases.
const HIGHLIGHT_BY_LANGUAGE: Record<string, (code: string) => React.ReactNode> =
  {
    c: cppHighlight,
    cpp: cppHighlight,
    "c++": cppHighlight,
    cc: cppHighlight,
    h: cppHighlight,
    hpp: cppHighlight,
    csharp: csharpHighlight,
    "c#": csharpHighlight,
    cs: csharpHighlight,
    css: cssHighlight,
    go: goHighlight,
    golang: goHighlight,
    html: htmlHighlight,
    htm: htmlHighlight,
    java: javaHighlight,
    javascript: javascriptHighlight,
    js: javascriptHighlight,
    jsx: javascriptHighlight,
    mjs: javascriptHighlight,
    cjs: javascriptHighlight,
    json: jsonHighlight,
    kotlin: kotlinHighlight,
    kt: kotlinHighlight,
    kts: kotlinHighlight,
    markdown: markdownHighlight,
    md: markdownHighlight,
    php: phpHighlight,
    python: pythonHighlight,
    py: pythonHighlight,
    ruby: rubyHighlight,
    rb: rubyHighlight,
    rust: rustHighlight,
    rs: rustHighlight,
    sh: shHighlight,
    bash: shHighlight,
    shell: shHighlight,
    zsh: shHighlight,
    typescript: typescriptHighlight,
    ts: typescriptHighlight,
    tsx: typescriptHighlight,
    xml: xmlHighlight,
    svg: xmlHighlight,
    yaml: yamlHighlight,
    yml: yamlHighlight,
  };

const getTextContent = (children: ReactNode): string =>
  Children.toArray(children).reduce<string>((text, child) => {
    if (typeof child === "string" || typeof child === "number") {
      return text + child;
    }
    return text;
  }, "");

const extractCodeBlock = (children: ReactNode): CodeBlock | undefined => {
  const [child] = Children.toArray(children);
  if (!isValidElement<CodeElementProps>(child)) {
    return undefined;
  }

  const languageMatch = /language-(\S+)/.exec(child.props.className ?? "");
  return {
    content: getTextContent(child.props.children).replace(/\n$/, ""),
    language: languageMatch?.[1]?.toLowerCase(),
  };
};

const renderCodeView = ({ content, language }: CodeBlock) => (
  <CodeView
    ariaLabel={language ? `${language} code snippet` : "Code snippet"}
    content={content}
    // hasOwn: tags like `__proto__` must not resolve to Object built-ins.
    highlight={
      language && Object.hasOwn(HIGHLIGHT_BY_LANGUAGE, language)
        ? HIGHLIGHT_BY_LANGUAGE[language]
        : undefined
    }
    lineNumbers
    wrapLines
  />
);

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => {
    const codeBlock = extractCodeBlock(children);
    return codeBlock ? renderCodeView(codeBlock) : <>{children}</>;
  },
  code: ({ className, children }) => (
    <code className={className}>{children}</code>
  ),
};

const TABLE_SEPARATOR = /\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?/;

const normalizeOneLineTable = (line: string): string => {
  const separatorMatch = TABLE_SEPARATOR.exec(line);

  if (!separatorMatch || separatorMatch.index === 0) {
    return line;
  }

  const header = line.slice(0, separatorMatch.index).trimEnd();
  const tableData = line
    .slice(separatorMatch.index + separatorMatch[0].length)
    .trim();
  const headerCells = header.slice(1, -1).split("|");
  const separatorCells = separatorMatch[0].split("|").filter(Boolean);

  if (
    !header.startsWith("|") ||
    !header.endsWith("|") ||
    !tableData.startsWith("|") ||
    !tableData.endsWith("|") ||
    headerCells.length !== separatorCells.length
  ) {
    return line;
  }

  const dataCells = tableData.slice(1, -1).split("|");
  const dataRows: string[] = [];
  let cellIndex = 0;

  while (cellIndex < dataCells.length) {
    const rowCells = dataCells.slice(cellIndex, cellIndex + headerCells.length);

    if (rowCells.length !== headerCells.length) {
      return line;
    }

    dataRows.push(`|${rowCells.join("|")}|`);
    cellIndex += headerCells.length;

    if (cellIndex === dataCells.length) {
      break;
    }

    if (dataCells[cellIndex].trim() !== "") {
      return line;
    }

    cellIndex += 1;

    if (cellIndex === dataCells.length) {
      return line;
    }
  }

  // Bedrock agents can return multiple GFM table rows on one line.
  return [header, separatorMatch[0].trimEnd(), ...dataRows].join("\n");
};

const normalizeOneLineTables = (content: string): string => {
  return content.split("\n").map(normalizeOneLineTable).join("\n");
};

export const MarkdownContent = ({ content }: MarkdownContentProps) => {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {normalizeOneLineTables(content)}
    </ReactMarkdown>
  );
};

export type MarkdownSegment = {
  kind: "text" | "code" | "table";
  content: string;
};

type ParsedMarkdownNode = {
  type: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

type ParsedMarkdown = {
  children: ParsedMarkdownNode[];
};

export const getMarkdownSegments = (content: string): MarkdownSegment[] => {
  const normalized = normalizeOneLineTables(content);
  const parsed = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(normalized) as ParsedMarkdown;
  const segments: MarkdownSegment[] = [];
  let previousEnd = 0;

  for (const node of parsed.children) {
    if (node.type !== "code" && node.type !== "table") {
      continue;
    }
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      continue;
    }

    appendTextSegment(segments, normalized.slice(previousEnd, start));
    const artifact = normalized.slice(start, end).trim();
    if (artifact) {
      segments.push({
        kind: node.type === "code" ? "code" : "table",
        content: artifact,
      });
    }
    previousEnd = end;
  }

  appendTextSegment(segments, normalized.slice(previousEnd));
  return segments;
};

const appendTextSegment = (segments: MarkdownSegment[], content: string) => {
  const text = content.trim();
  if (text) {
    segments.push({ kind: "text", content: text });
  }
};
