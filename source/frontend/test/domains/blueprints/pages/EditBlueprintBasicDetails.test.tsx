// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { showSuccessToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditBlueprintBasicDetails } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/EditBlueprintBasicDetails";
import type { UpdateBlueprintRequest } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  createBlueprint,
  createBlueprintWithStackSets,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";
import { mockBlueprint } from "@amzn/innovation-sandbox-frontend/mocks/handlers/blueprintHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockBlueprintId = mockBlueprint.blueprint.blueprintId;

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ blueprintId: mockBlueprintId }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
}));

describe("EditBlueprintBasicDetails", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditBlueprintBasicDetails />
      </Router>,
    );

  test("renders loading state initially", () => {
    renderComponent();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  test("renders form with existing blueprint data", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("Blueprint Name")).toHaveValue(
        mockBlueprint.blueprint.name,
      );
    });
  });

  test("navigates back on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Blueprint Name")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith(`/blueprints/${mockBlueprintId}`);
  });

  test("submits form successfully and shows success toast", async () => {
    const submitSpy = vi.fn();
    server.use(
      http.put(
        `${getConfig().ApiUrl}/blueprints/${mockBlueprintId}`,
        async ({ request }) => {
          const data = (await request.json()) as UpdateBlueprintRequest;
          submitSpy(data);
          return HttpResponse.json({
            status: "success",
            data: createBlueprintWithStackSets({
              blueprint: createBlueprint({
                ...mockBlueprint.blueprint,
                ...data,
              }),
            }),
          });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Blueprint Name")).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText("Blueprint Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Updated-Blueprint-Name");

    // Wait for async Zod validation to settle (tags have regex refinements)
    // so the save button becomes enabled before clicking
    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => {
      expect(saveButton).not.toBeDisabled();
    });

    await user.click(saveButton);

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Blueprint details updated successfully",
      );
      expect(mockNavigate).toHaveBeenCalledWith(
        `/blueprints/${mockBlueprintId}`,
      );
    });
  });

  test("disables save button when form is invalid", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Blueprint Name")).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText("Blueprint Name");
    await user.clear(nameInput);

    await waitFor(() => {
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      expect(saveButton).toBeDisabled();
    });
  });

  test("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("Blueprint Name")).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toBeDisabled();
  });

  test("displays error panel when blueprint fails to load", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/blueprints/${mockBlueprintId}`, () => {
        return HttpResponse.json(
          { status: "error", message: "Not found" },
          { status: 404 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(/There was a problem loading this blueprint/i),
      ).toBeInTheDocument();
    });
  });

  describe("tag keys", () => {
    const addTagWithKey = async (
      user: ReturnType<typeof userEvent.setup>,
      key: string,
    ) => {
      await user.click(screen.getByRole("button", { name: /add tag/i }));
      const keyInputs = screen.getAllByPlaceholderText(
        "e.g., Environment, Cost-Center, Project",
      );
      await user.type(keyInputs[keyInputs.length - 1], key);
    };

    test("shows an error and disables save when a tag key is only spaces", async () => {
      renderComponent();
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByLabelText("Blueprint Name")).toBeInTheDocument();
      });

      await addTagWithKey(user, "   ");

      await waitFor(() => {
        expect(screen.getByText("Tag key is required")).toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", { name: /save changes/i }),
      ).toBeDisabled();
    });

    test("saves tag keys without leading and trailing spaces", async () => {
      const submitSpy = vi.fn();
      server.use(
        http.put(
          `${getConfig().ApiUrl}/blueprints/${mockBlueprintId}`,
          async ({ request }) => {
            const data = (await request.json()) as UpdateBlueprintRequest;
            submitSpy(data);
            return HttpResponse.json({
              status: "success",
              data: createBlueprintWithStackSets({
                blueprint: createBlueprint({
                  ...mockBlueprint.blueprint,
                  ...data,
                }),
              }),
            });
          },
        ),
      );

      renderComponent();
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByLabelText("Blueprint Name")).toBeInTheDocument();
      });

      await addTagWithKey(user, " owner ");

      const saveButton = screen.getByRole("button", { name: /save changes/i });
      await waitFor(() => {
        expect(saveButton).not.toBeDisabled();
      });
      await user.click(saveButton);

      await waitFor(() => {
        expect(submitSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            tags: { ...mockBlueprint.blueprint.tags, owner: "" },
          }),
        );
      });
    });
  });
});
