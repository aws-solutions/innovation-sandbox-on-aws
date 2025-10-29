// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VisibilityIndicator } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/VisibilityIndicator";
import { createLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseTemplateFactory";

describe("VisibilityIndicator", () => {
  it("should render public visibility with correct text", () => {
    const publicTemplate = createLeaseTemplate({ visibility: "PUBLIC" });

    render(<VisibilityIndicator item={publicTemplate} />);

    expect(screen.getByText("Public")).toBeInTheDocument();
  });

  it("should render private visibility with correct text", () => {
    const privateTemplate = createLeaseTemplate({ visibility: "PRIVATE" });

    render(<VisibilityIndicator item={privateTemplate} />);

    expect(screen.getByText("Private")).toBeInTheDocument();
  });
});
