// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@cloudscape-design/components";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CatalogDraft,
  ModelCatalogTable,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/ModelCatalogTable";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock toast functions — they render into a ToastContainer that isn't present
// in the test environment; mocking lets us assert on calls without a DOM container.
vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";

vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
    getCurrentUser: vi.fn().mockResolvedValue({
      status: "authenticated",
      user: {
        type: "user",
        email: "admin@example.com",
        userId: "a1",
        roles: ["Admin"],
      },
    }),
    getIdToken: vi.fn().mockResolvedValue("mock-id-token"),
    getCredentials: vi.fn().mockResolvedValue({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-not-a-real-key",
      sessionToken: "test-session-token",
    }),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

const MOCK_META = {
  createdTime: "2026-01-01T00:00:00.000Z",
  lastEditTime: "2026-09-01T12:00:00.000Z",
};

function makeCatalogRow(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "anthropic.claude-3-haiku-20240307-v1:0",
    displayName: "Claude 3 Haiku",
    provider: "Anthropic",
    availability: "global",
    pricingSource: "agreement-offers",
    pricingRefreshedAt: "2026-09-18T00:00:00.000Z",
    inputPricePer1KTokens: 0.001,
    outputPricePer1KTokens: 0.005,
    cacheReadPricePer1KTokens: 0.0001,
    cacheWritePricePer1KTokens: 0.0002,
    enabled: true,
    addedAt: "2026-09-01T12:00:00.000Z",
    lastSavedBy: "admin@example.com",
    meta: MOCK_META,
    ...overrides,
  };
}

const apiUrl = () => getConfig().ApiUrl;

function mockGetCatalog(models: unknown[] = [makeCatalogRow()]) {
  server.use(
    http.get(`${apiUrl()}/configurations/agent/models`, () =>
      HttpResponse.json({ status: "success", data: { models } }),
    ),
  );
}

function mockGetCatalogEmpty() {
  server.use(
    http.get(`${apiUrl()}/configurations/agent/models`, () =>
      HttpResponse.json({ status: "success", data: { models: [] } }),
    ),
  );
}

function mockUpsertSuccess(returnRow: unknown = makeCatalogRow()) {
  const bodies: Array<Record<string, unknown>> = [];
  server.use(
    http.put(
      `${apiUrl()}/configurations/agent/models/:modelId`,
      async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ status: "success", data: returnRow });
      },
    ),
  );
  return bodies;
}

function mockUpsert409() {
  server.use(
    http.put(`${apiUrl()}/configurations/agent/models/:modelId`, () =>
      HttpResponse.json({ status: "fail", data: {} }, { status: 409 }),
    ),
  );
}

function CatalogHarness() {
  const [draft, setDraft] = useState<CatalogDraft | null>(null);
  return (
    <>
      <ModelCatalogTable onDraftChange={setDraft} />
      <Button
        disabled={!draft?.dirty || draft.conflict}
        onClick={() => void draft?.save()}
      >
        Save
      </Button>
      <Button disabled={!draft?.dirty} onClick={() => draft?.discard()}>
        Cancel
      </Button>
    </>
  );
}

// ModelCatalogTable uses useNavigate so it must be wrapped in a router.
function renderTable() {
  const router = createMemoryRouter([
    { path: "*", element: <CatalogHarness /> },
  ]);
  render(<RouterProvider router={router} />, {
    wrapper: createQueryClientWrapper(),
  });
  return router;
}

beforeEach(() => {
  mockGetCatalogEmpty();
});

describe("ModelCatalogTable", () => {
  // ── Empty state ─────────────────────────────────────────────────────────

  it("renders the empty state when the catalog has no models", async () => {
    renderTable();

    expect(
      await screen.findByText(/no sandbox spaces models/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/add tool-capable bedrock models/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add models/i }),
    ).toBeInTheDocument();
  });

  it("renders the catalog table when models are present", async () => {
    mockGetCatalog([makeCatalogRow()]);

    renderTable();

    expect(await screen.findByText("Claude 3 Haiku")).toBeInTheDocument();
  });

  it("hides disabled rows, showing the empty state when all are disabled", async () => {
    mockGetCatalog([makeCatalogRow({ enabled: false })]);

    renderTable();

    expect(
      await screen.findByText(/no sandbox spaces models/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Claude 3 Haiku")).not.toBeInTheDocument();
  });

  it("renders pricing columns", async () => {
    mockGetCatalog([
      makeCatalogRow({
        inputPricePer1KTokens: 0.001,
        outputPricePer1KTokens: 0.005,
      }),
    ]);

    renderTable();

    await screen.findByText("Claude 3 Haiku");
    expect(screen.getByText("$0.0010")).toBeInTheDocument();
    expect(screen.getByText("$0.0050")).toBeInTheDocument();
  });

  it("stages Disable without writing, then sends enabled:false on Save", async () => {
    mockGetCatalog([makeCatalogRow({ enabled: true })]);
    const bodies = mockUpsertSuccess(makeCatalogRow({ enabled: false }));

    const user = userEvent.setup();
    renderTable();

    await screen.findByText("Claude 3 Haiku");
    // Table has header checkbox + row checkbox; click the row checkbox (last one)
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[checkboxes.length - 1]);

    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /disable/i }));

    await screen.findByText(
      /1 model will be disabled when you save this group/,
    );
    expect(bodies).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ enabled: false });
    expect(bodies[0]).toHaveProperty(
      "expectedLastEditTime",
      MOCK_META.lastEditTime,
    );
  });

  it("does not offer an Enable action (only enabled models are shown)", async () => {
    mockGetCatalog([makeCatalogRow({ enabled: true })]);

    const user = userEvent.setup();
    renderTable();

    await screen.findByText("Claude 3 Haiku");
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[checkboxes.length - 1]);

    await user.click(screen.getByRole("button", { name: /actions/i }));
    expect(
      screen.queryByRole("menuitem", { name: /enable/i }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("menuitem", { name: /disable/i }),
    ).toBeInTheDocument();
  });

  it("shows a conflict toast on 409 and does not crash", async () => {
    mockGetCatalog([
      makeCatalogRow(),
      makeCatalogRow({
        modelId: "amazon.nova-pro-v1:0",
        displayName: "Nova Pro",
      }),
    ]);
    mockUpsert409();

    const user = userEvent.setup();
    renderTable();

    await screen.findByText("Claude 3 Haiku");
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[checkboxes.length - 1]);

    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /disable/i }));

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringMatching(/updated by another admin/i),
        "Action failed",
      ),
    );
    expect(
      await screen.findByText("Model catalog conflict"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refresh model catalog" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/1 model will be disabled when you save this group/),
    ).toBeInTheDocument();
  });

  it("names only conflicting editors when a batch has both 409 and 500 failures", async () => {
    const models = [
      makeCatalogRow({ lastSavedBy: "conflict-editor@example.com" }),
      makeCatalogRow({
        modelId: "amazon.nova-pro-v1:0",
        displayName: "Nova Pro",
        lastSavedBy: "unrelated-editor@example.com",
      }),
    ];
    mockGetCatalog(models);
    server.use(
      http.put(
        `${apiUrl()}/configurations/agent/models/:modelId`,
        ({ params }) =>
          HttpResponse.json(
            { status: "fail", data: {} },
            { status: params.modelId === models[0].modelId ? 409 : 500 },
          ),
      ),
    );

    const user = userEvent.setup();
    renderTable();

    await screen.findByText("Claude 3 Haiku");
    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /disable/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const attribution = await screen.findByText(/saved these settings/);
    expect(attribution).toHaveTextContent(
      "conflict-editor@example.com saved these settings.",
    );
    expect(attribution).not.toHaveTextContent("unrelated-editor@example.com");
    expect(
      screen.getByText(/2 models will be disabled when you save this group/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("clears a discarded conflict and allows a new catalog edit to save", async () => {
    mockGetCatalog([makeCatalogRow()]);
    mockUpsert409();

    const user = userEvent.setup();
    renderTable();

    await screen.findByText("Claude 3 Haiku");
    await user.click(screen.getAllByRole("checkbox").at(-1)!);
    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /disable/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Model catalog conflict");
    await screen.findByText(/admin@example.com saved these settings/);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.queryByText("Model catalog conflict"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/admin@example.com saved these settings/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/model will be disabled when you save this group/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Claude 3 Haiku")).toBeInTheDocument();

    const bodies = mockUpsertSuccess(makeCatalogRow({ enabled: false }));
    await user.click(screen.getAllByRole("checkbox").at(-1)!);
    await user.click(screen.getByRole("button", { name: /actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /disable/i }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.queryByText(/model will be disabled when you save this group/),
      ).not.toBeInTheDocument(),
    );
  });

  it("drops rows without an OCC token (meta.lastEditTime) at the adapter", async () => {
    // The canonical listCatalog() adapter drops any row missing meta.lastEditTime
    // (it could not be safely toggled under OCC), so such a row never reaches the
    // table. With only an incomplete row in the catalog, the table shows its
    // empty state rather than a non-toggleable row.
    const rowNoMeta = makeCatalogRow({
      meta: {
        createdTime: "2026-01-01T00:00:00.000Z",
        lastEditTime: undefined,
      },
    });
    mockGetCatalog([rowNoMeta]);

    renderTable();

    expect(
      await screen.findByText("No Sandbox Spaces models"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Claude 3 Haiku")).not.toBeInTheDocument();
  });

  it("Actions dropdown is disabled when nothing is selected", async () => {
    mockGetCatalog([makeCatalogRow()]);

    renderTable();

    await screen.findByText("Claude 3 Haiku");
    // Cloudscape ButtonDropdown renders disabled as native disabled attribute
    const actions = screen.getByRole("button", { name: /actions/i });
    expect(actions).toBeDisabled();
  });
});
