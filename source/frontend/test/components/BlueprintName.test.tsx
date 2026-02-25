// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";

describe("BlueprintName", () => {
  it("should show 'No Blueprint' when blueprintName is null", () => {
    render(<BlueprintName blueprintName={null} />);
    expect(screen.getByText("No Blueprint")).toBeInTheDocument();
  });

  it("should show 'No Blueprint' when blueprintName is undefined", () => {
    render(<BlueprintName blueprintName={undefined} />);
    expect(screen.getByText("No Blueprint")).toBeInTheDocument();
  });

  it("should show 'No Blueprint' when blueprintName is empty string", () => {
    render(<BlueprintName blueprintName="" />);
    expect(screen.getByText("No Blueprint")).toBeInTheDocument();
  });

  it("should show blueprint name when provided", () => {
    render(<BlueprintName blueprintName="Test-Blueprint" />);
    expect(screen.getByText("Test-Blueprint")).toBeInTheDocument();
  });
});
