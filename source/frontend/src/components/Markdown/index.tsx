// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { HelpPanel } from "@cloudscape-design/components";
import fm from "front-matter";
import { useEffect, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";

import { MarkdownLink } from "@amzn/innovation-sandbox-frontend/components/Markdown/MarkdownLink";

interface MarkdownProps {
  file: string;
}

interface MarkdownData {
  attributes: {
    title: string;
  };
  markdown: string;
}

const markdownComponents: Components = {
  a: (props: any) => <MarkdownLink {...props} />,
};

export const Markdown = ({ file }: MarkdownProps) => {
  const [markdown, setMarkdown] = useState<MarkdownData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const init = async () => {
    setError(null);
    const response = await fetch(`/markdown/${file}.md`);
    if (!response.ok) {
      setError(`Failed to load markdown file: ${response.status}`);
      return;
    }

    const rawMarkdown = await response.text();
    const parsed = fm<{ title?: string }>(rawMarkdown);

    setMarkdown({
      attributes: {
        title: parsed.attributes.title || file,
      },
      markdown: parsed.body,
    });
  };

  useEffect(() => {
    init();
  }, [file]);

  if (error) {
    return (
      <HelpPanel header="Error">
        <p>Failed to load markdown content: {error}</p>
      </HelpPanel>
    );
  }

  if (markdown) {
    return (
      <HelpPanel header={markdown.attributes.title}>
        <ReactMarkdown components={markdownComponents}>
          {markdown.markdown}
        </ReactMarkdown>
      </HelpPanel>
    );
  }

  return (
    <HelpPanel header="Loading...">
      <p>Loading markdown content...</p>
    </HelpPanel>
  );
};
