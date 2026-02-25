// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ImInfo } from "react-icons/im";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";

import styles from "./styles.module.scss";

interface InfoLinkProps {
  text?: string;
  markdown: string;
}

export const InfoLink = ({ text, markdown }: InfoLinkProps) => {
  const { setTools, setToolsOpen, setToolsHide } = useAppLayoutContext();

  const onClick = () => {
    setTools(<Markdown file={markdown} />);
    setToolsHide(false);
    setToolsOpen(true);
  };

  return (
    <TextLink onClick={onClick}>
      <div className={styles.container}>
        <ImInfo size={18} />
        {text && <span className={styles.text}>{text}</span>}
      </div>
    </TextLink>
  );
};
