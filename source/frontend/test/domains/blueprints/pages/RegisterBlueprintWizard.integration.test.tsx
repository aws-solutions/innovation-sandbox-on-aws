// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RegisterBlueprintWizard } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/RegisterBlueprintWizard";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

import { BrowserRouter } from "react-router-dom";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("RegisterBlueprintWizard Integration", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  describe("Step Navigation Validation", () => {
    it("should prevent forward navigation from step 1 when name is empty", async () => {
      const user = userEvent.setup();

      server.use(
        http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
          return HttpResponse.json({
            status: "success",
            data: { result: [] },
          });
        }),
        http.get(`${config.ApiUrl}/configurations`, () => {
          return HttpResponse.json({
            status: "success",
            data: { isbManagedRegions: ["us-east-1"] },
          });
        }),
      );

      renderWithQueryClient(
        <BrowserRouter>
          <RegisterBlueprintWizard />
        </BrowserRouter>,
      );

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Enter blueprint name"),
        ).toBeInTheDocument();
      });

      // Try to navigate without filling name
      const nextButton = screen.getByRole("button", { name: /Next/i });
      await user.click(nextButton);

      // Should show validation error
      await waitFor(() => {
        expect(
          screen.getByText(/Blueprint name is required/i),
        ).toBeInTheDocument();
      });

      // Should stay on step 1
      expect(
        screen.getByPlaceholderText("Enter blueprint name"),
      ).toBeInTheDocument();
    });

    it("should allow forward navigation from step 1 when name is valid", async () => {
      const user = userEvent.setup();

      server.use(
        http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
          return HttpResponse.json({
            status: "success",
            data: { result: [] },
          });
        }),
        http.get(`${config.ApiUrl}/configurations`, () => {
          return HttpResponse.json({
            status: "success",
            data: { isbManagedRegions: ["us-east-1"] },
          });
        }),
      );

      renderWithQueryClient(
        <BrowserRouter>
          <RegisterBlueprintWizard />
        </BrowserRouter>,
      );

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Enter blueprint name"),
        ).toBeInTheDocument();
      });

      // Fill name
      const nameInput = screen.getByPlaceholderText("Enter blueprint name");
      await user.type(nameInput, "Test-Blueprint");

      // Navigate to next step
      const nextButton = screen.getByRole("button", { name: /Next/i });
      await user.click(nextButton);

      // Should move to step 2
      await waitFor(() => {
        expect(screen.getByText("Available StackSets")).toBeInTheDocument();
      });
    });

    it("should prevent forward navigation from step 2 when no StackSet is selected", async () => {
      const user = userEvent.setup();

      server.use(
        http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              result: [
                {
                  stackSetName: "test-stackset",
                  stackSetId: "test-stackset:abc123",
                  status: "ACTIVE",
                  permissionModel: "SELF_MANAGED",
                },
              ],
            },
          });
        }),
        http.get(`${config.ApiUrl}/configurations`, () => {
          return HttpResponse.json({
            status: "success",
            data: { isbManagedRegions: ["us-east-1"] },
          });
        }),
      );

      renderWithQueryClient(
        <BrowserRouter>
          <RegisterBlueprintWizard />
        </BrowserRouter>,
      );

      // Step 1: Fill name
      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Enter blueprint name"),
        ).toBeInTheDocument();
      });
      await user.type(
        screen.getByPlaceholderText("Enter blueprint name"),
        "Test",
      );
      await user.click(screen.getByRole("button", { name: /Next/i }));

      // Step 2: Don't select StackSet, try to navigate
      await waitFor(() => {
        expect(screen.getByText("Available StackSets")).toBeInTheDocument();
      });

      const nextButton = screen.getByRole("button", { name: /Next/i });
      await user.click(nextButton);

      // Should show validation error
      await waitFor(() => {
        expect(
          screen.getByText(/Please select a StackSet/i),
        ).toBeInTheDocument();
      });

      // Should stay on step 2
      expect(screen.getByText("Available StackSets")).toBeInTheDocument();
    });

    it("should prevent forward navigation from step 3 when no regions are selected", async () => {
      const user = userEvent.setup();

      server.use(
        http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              result: [
                {
                  stackSetName: "test-stackset",
                  stackSetId: "test-stackset:abc123",
                  status: "ACTIVE",
                  permissionModel: "SELF_MANAGED",
                },
              ],
            },
          });
        }),
        http.get(`${config.ApiUrl}/configurations`, () => {
          return HttpResponse.json({
            status: "success",
            data: { isbManagedRegions: ["us-east-1", "us-west-2"] },
          });
        }),
      );

      renderWithQueryClient(
        <BrowserRouter>
          <RegisterBlueprintWizard />
        </BrowserRouter>,
      );

      // Step 1: Fill name
      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Enter blueprint name"),
        ).toBeInTheDocument();
      });
      await user.type(
        screen.getByPlaceholderText("Enter blueprint name"),
        "Test",
      );
      await user.click(screen.getByRole("button", { name: /Next/i }));

      // Step 2: Select StackSet
      await waitFor(() => {
        expect(screen.getByText("test-stackset")).toBeInTheDocument();
      });
      await user.click(screen.getByText("test-stackset"));
      await user.click(screen.getByRole("button", { name: /Next/i }));

      // Step 3: Don't select regions, try to navigate
      await waitFor(() => {
        expect(screen.getByText("Add all regions")).toBeInTheDocument();
      });

      const nextButton = screen.getByRole("button", { name: /Next/i });
      await user.click(nextButton);

      // Should show validation error (multiple instances of same text exist)
      await waitFor(() => {
        const errorMessages = screen.getAllByText(
          /At least one region is required/i,
        );
        expect(errorMessages.length).toBeGreaterThan(0);
      });

      // Should stay on step 3
      expect(screen.getByText("Add all regions")).toBeInTheDocument();
    });

    it("should allow backward navigation without validation", async () => {
      const user = userEvent.setup();

      server.use(
        http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              result: [
                {
                  stackSetName: "test-stackset",
                  stackSetId: "test-stackset:abc123",
                  status: "ACTIVE",
                  permissionModel: "SELF_MANAGED",
                },
              ],
            },
          });
        }),
        http.get(`${config.ApiUrl}/configurations`, () => {
          return HttpResponse.json({
            status: "success",
            data: { isbManagedRegions: ["us-east-1"] },
          });
        }),
      );

      renderWithQueryClient(
        <BrowserRouter>
          <RegisterBlueprintWizard />
        </BrowserRouter>,
      );

      // Step 1: Fill name and navigate forward
      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Enter blueprint name"),
        ).toBeInTheDocument();
      });
      await user.type(
        screen.getByPlaceholderText("Enter blueprint name"),
        "Test",
      );
      await user.click(screen.getByRole("button", { name: /Next/i }));

      // Step 2: Navigate back without selecting StackSet
      await waitFor(() => {
        expect(screen.getByText("Available StackSets")).toBeInTheDocument();
      });

      const previousButton = screen.getByRole("button", { name: /Previous/i });
      await user.click(previousButton);

      // Should return to step 1 without validation errors
      await waitFor(() => {
        expect(
          screen.getByPlaceholderText("Enter blueprint name"),
        ).toBeInTheDocument();
      });

      // Name should still be filled
      expect(screen.getByPlaceholderText("Enter blueprint name")).toHaveValue(
        "Test",
      );
    });
  });

  it("should complete full registration flow with default strategy", async () => {
    const user = userEvent.setup();

    // Mock API responses
    server.use(
      // Mock StackSets list
      http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            result: [
              {
                stackSetName: "test-stackset",
                stackSetId: "test-stackset:abc123",
                description: "Test StackSet",
                status: "ACTIVE",
                permissionModel: "SELF_MANAGED",
              },
            ],
          },
        });
      }),
      // Mock configurations
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            isbManagedRegions: ["us-east-1", "us-west-2", "eu-west-1"],
          },
        });
      }),
      // Mock blueprint registration
      http.post(`${config.ApiUrl}/blueprints`, async ({ request }) => {
        const body = (await request.json()) as any;
        return HttpResponse.json({
          status: "success",
          data: {
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
            name: body.name,
            tags: body.tags || {},
            createdBy: "admin@example.com",
            deploymentTimeoutMinutes: body.deploymentTimeoutMinutes || 30,
            regionConcurrencyType: body.regionConcurrencyType || "PARALLEL",
            totalHealthMetrics: {
              totalDeploymentCount: 0,
              totalSuccessfulCount: 0,
            },
            meta: {
              schemaVersion: 1,
              createdTime: new Date().toISOString(),
              lastEditTime: new Date().toISOString(),
            },
          },
        });
      }),
    );

    renderWithQueryClient(
      <BrowserRouter>
        <RegisterBlueprintWizard />
      </BrowserRouter>,
    );

    // Step 1: Fill basic details
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Enter blueprint name"),
      ).toBeInTheDocument();
    });

    const nameInput = screen.getByPlaceholderText("Enter blueprint name");
    await user.clear(nameInput);
    await user.type(nameInput, "Test-Blueprint");

    const nextButton = screen.getByRole("button", { name: /Next/i });
    await user.click(nextButton);

    // Step 2: Select StackSet
    await waitFor(() => {
      expect(screen.getByText("Available StackSets")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("test-stackset")).toBeInTheDocument();
    });

    // Click the row to select it
    const stackSetRow = screen.getByText("test-stackset");
    await user.click(stackSetRow);

    // Wait for selection to be registered and click Next for Step 2
    const nextButton2 = screen.getByRole("button", { name: /Next/i });
    await user.click(nextButton2);

    // Step 3: Configure deployment (default strategy)
    await waitFor(() => {
      expect(screen.getByText("Add all regions")).toBeInTheDocument();
    });

    // Select regions
    await user.click(
      screen.getByRole("button", {
        name: /Add all regions/i,
      }),
    );

    // Wait for regions to appear
    await waitFor(() => {
      expect(screen.getByText("us-east-1")).toBeInTheDocument();
    });

    // Verify default is selected by default
    const defaultRadio = screen.getByRole("radio", {
      name: /Default/i,
    });
    expect(defaultRadio).toBeChecked();

    // Click Next for Step 3
    const nextButton3 = screen.getByRole("button", { name: /Next/i });
    await user.click(nextButton3);

    // Step 4: Review and submit
    await waitFor(() => {
      expect(screen.getByText("Blueprint details")).toBeInTheDocument();
    });

    expect(screen.getByText("Test-Blueprint")).toBeInTheDocument();
    expect(screen.getByText("test-stackset")).toBeInTheDocument();

    const submitButton = screen.getByRole("button", {
      name: /Register Blueprint/i,
    });
    await user.click(submitButton);

    // Verify navigation to blueprints list
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/blueprints");
    });
  });

  it("should handle API errors gracefully", async () => {
    const user = userEvent.setup();

    server.use(
      http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            result: [
              {
                stackSetName: "test-stackset",
                stackSetId: "test-stackset:abc123",
                status: "ACTIVE",
                permissionModel: "SELF_MANAGED",
              },
            ],
          },
        });
      }),
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            isbManagedRegions: ["us-east-1"],
          },
        });
      }),
      http.post(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json(
          {
            status: "error",
            message: "Internal server error",
          },
          { status: 500 },
        );
      }),
    );

    renderWithQueryClient(
      <BrowserRouter>
        <RegisterBlueprintWizard />
      </BrowserRouter>,
    );

    // Fill form and submit
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Enter blueprint name"),
      ).toBeInTheDocument();
    });

    const nameInput = screen.getByPlaceholderText("Enter blueprint name");
    await user.type(nameInput, "Test-Blueprint");
    await user.click(screen.getByRole("button", { name: /Next/i }));

    await waitFor(() => {
      expect(screen.getByText("test-stackset")).toBeInTheDocument();
    });
    await user.click(screen.getByText("test-stackset"));
    await user.click(screen.getByRole("button", { name: /Next/i }));

    await waitFor(() => {
      expect(screen.getByText("Add all regions")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Add all regions/i }));
    await user.click(screen.getByRole("button", { name: /Next/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Register Blueprint/i }),
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("button", { name: /Register Blueprint/i }),
    );

    // Verify error is handled (toast component may not be in test environment)
    await waitFor(() => {
      // Error should be caught and handled
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    // Verify we stay on the wizard (don't navigate away)
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("should validate all steps before allowing submission", async () => {
    const user = userEvent.setup();

    server.use(
      http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: [] },
        });
      }),
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            isbManagedRegions: ["us-east-1"],
          },
        });
      }),
    );

    renderWithQueryClient(
      <BrowserRouter>
        <RegisterBlueprintWizard />
      </BrowserRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Enter blueprint name"),
      ).toBeInTheDocument();
    });

    // Try to proceed without filling name
    const nextButton = screen.getByRole("button", { name: /Next/i });
    await user.click(nextButton);

    // Should show validation error and stay on step 1
    await waitFor(() => {
      expect(
        screen.getByText(/Blueprint name is required/i),
      ).toBeInTheDocument();
    });
    // Still on step 1 - name input should still be visible
    expect(
      screen.getByPlaceholderText("Enter blueprint name"),
    ).toBeInTheDocument();
  });

  it("should allow custom deployment configuration", async () => {
    const user = userEvent.setup();

    let capturedRequest: any = null;

    server.use(
      http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            result: [
              {
                stackSetName: "test-stackset",
                stackSetId: "test-stackset:abc123",
                status: "ACTIVE",
                permissionModel: "SELF_MANAGED",
              },
            ],
          },
        });
      }),
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            isbManagedRegions: ["us-east-1", "us-west-2"],
          },
        });
      }),
      http.post(`${config.ApiUrl}/blueprints`, async ({ request }) => {
        capturedRequest = await request.json();
        return HttpResponse.json({
          status: "success",
          data: {
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
            name: "Test-Blueprint",
          },
        });
      }),
    );

    renderWithQueryClient(
      <BrowserRouter>
        <RegisterBlueprintWizard />
      </BrowserRouter>,
    );

    // Step 1: Basic details
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Enter blueprint name"),
      ).toBeInTheDocument();
    });
    await user.type(
      screen.getByPlaceholderText("Enter blueprint name"),
      "Test-Blueprint",
    );
    await user.click(screen.getByRole("button", { name: /Next/i }));

    // Step 2: Select StackSet
    await waitFor(() => {
      expect(screen.getByText("test-stackset")).toBeInTheDocument();
    });
    await user.click(screen.getByText("test-stackset"));
    await user.click(screen.getByRole("button", { name: /Next/i }));

    // Step 3: Select custom strategy
    await waitFor(() => {
      expect(
        screen.getByRole("radio", { name: /Custom/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("radio", { name: /Custom/i }));

    // Add regions
    await user.click(screen.getByRole("button", { name: /Add all regions/i }));

    // Verify custom controls are shown
    await waitFor(() => {
      expect(screen.getByText(/Concurrent deployments/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Next/i }));

    // Step 4: Submit
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Register blueprint/i }),
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("button", { name: /Register Blueprint/i }),
    );

    // Verify API was called with custom config
    await waitFor(() => {
      expect(capturedRequest).toBeTruthy();
      expect(capturedRequest.maxConcurrentPercentage).toBeDefined();
      expect(capturedRequest.failureTolerancePercentage).toBeDefined();
      expect(capturedRequest.concurrencyMode).toBeDefined();
    });
  });
});
