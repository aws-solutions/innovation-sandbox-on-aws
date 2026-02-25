// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { RegionListBuilder } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/RegionListBuilder";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("RegionListBuilder", () => {
  it("should call onChange when Add all regions is clicked", async () => {
    const user = userEvent.setup();
    const mockOnChange = vi.fn();

    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            isbManagedRegions: ["us-east-1", "us-west-2", "eu-west-1"],
          },
        });
      }),
    );

    renderWithQueryClient(
      <RegionListBuilder selectedRegions={[]} onChange={mockOnChange} />,
    );

    // Wait for component to load
    await waitFor(() => {
      expect(screen.getByText("Add all regions")).toBeInTheDocument();
    });

    // Click Add all regions
    const addAllButton = screen.getByRole("button", {
      name: /Add all regions/i,
    });

    await user.click(addAllButton);

    // Verify onChange was called with all regions
    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith([
        "us-east-1",
        "us-west-2",
        "eu-west-1",
      ]);
    });
  });

  it("should display selected regions in sortable list", async () => {
    const mockOnChange = vi.fn();

    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            isbManagedRegions: ["us-east-1", "us-west-2"],
          },
        });
      }),
    );

    renderWithQueryClient(
      <RegionListBuilder
        selectedRegions={["us-east-1", "us-west-2"]}
        onChange={mockOnChange}
      />,
    );

    // Verify regions appear in list
    await waitFor(() => {
      expect(screen.getByText("us-east-1")).toBeInTheDocument();
      expect(screen.getByText("us-west-2")).toBeInTheDocument();
    });
  });

  it("should call onChange when Remove button is clicked", async () => {
    const user = userEvent.setup();
    const mockOnChange = vi.fn();

    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            isbManagedRegions: ["us-east-1", "us-west-2"],
          },
        });
      }),
    );

    renderWithQueryClient(
      <RegionListBuilder
        selectedRegions={["us-east-1", "us-west-2"]}
        onChange={mockOnChange}
      />,
    );

    // Wait for regions to appear
    await waitFor(() => {
      expect(screen.getByText("us-east-1")).toBeInTheDocument();
    });

    // Click Remove button for first region
    const removeButtons = screen.getAllByLabelText(/Delete us-east-1/i);
    await user.click(removeButtons[0]);

    // Verify onChange was called with filtered array
    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith(["us-west-2"]);
    });
  });
});
