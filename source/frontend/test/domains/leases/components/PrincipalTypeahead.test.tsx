// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { PrincipalTypeahead } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead";
import type { IdcPrincipalView } from "@amzn/innovation-sandbox-frontend/domains/principals/model";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

vi.mock(
  "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService",
  async () => {
    const [{ authenticated }, { buildCognitoAuthServiceMock }] =
      await Promise.all([
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures"),
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoServiceMock"),
      ]);
    return {
      CognitoAuthService: buildCognitoAuthServiceMock({
        getCurrentUser: vi.fn().mockResolvedValue(authenticated()),
      }),
    };
  },
);

const alice: IdcPrincipalView = {
  principalId: "user-1",
  principalType: "USER",
  displayName: "Alice Smith",
  email: "alice@example.com",
};

const engineering: IdcPrincipalView = {
  principalId: "group-1",
  principalType: "GROUP",
  displayName: "Engineering",
};

const bob: IdcPrincipalView = {
  principalId: "user-2",
  principalType: "USER",
  displayName: "Bob Jones",
  email: "bob@example.com",
};

function stubPrincipalsEndpoint(
  responder: (url: URL) => IdcPrincipalView[],
  recorder?: { calls: URL[] },
) {
  server.use(
    http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
      const url = new URL(request.url);
      recorder?.calls.push(url);
      const principals = responder(url);
      return HttpResponse.json({
        status: "success",
        data: { principals, totalMatches: principals.length },
      });
    }),
  );
}

function renderTypeahead(
  props: Partial<React.ComponentProps<typeof PrincipalTypeahead>> = {},
) {
  const onSelect = vi.fn();
  const Wrapper = createQueryClientWrapper();
  const utils = render(
    <Wrapper>
      <PrincipalTypeahead onSelect={onSelect} {...props} />
    </Wrapper>,
  );
  return { ...utils, onSelect };
}

describe("PrincipalTypeahead", () => {
  it("does not call the API for input shorter than 2 chars", async () => {
    const recorder = { calls: [] as URL[] };
    stubPrincipalsEndpoint(() => [alice], recorder);

    const { onSelect } = renderTypeahead();
    const input = screen.getByPlaceholderText("Search or enter email");
    const user = userEvent.setup();

    await user.type(input, "a");

    vi.useFakeTimers();
    try {
      await act(async () => {
        vi.advanceTimersByTime(250);
      });

      expect(recorder.calls).toHaveLength(0);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces input and queries the API after 2+ characters", async () => {
    const recorder = { calls: [] as URL[] };
    stubPrincipalsEndpoint(() => [alice], recorder);

    renderTypeahead();
    const input = screen.getByPlaceholderText("Search or enter email");
    const user = userEvent.setup();

    await user.type(input, "alice");

    await waitFor(() => expect(recorder.calls.length).toBeGreaterThan(0));
    const lastCall = recorder.calls[recorder.calls.length - 1];
    expect(lastCall.searchParams.get("q")).toBe("alice");
    expect(lastCall.searchParams.get("type")).toBe("users");
    expect(lastCall.searchParams.get("limit")).toBe("20");
  });

  it("excludes already-assigned principals from the listbox", async () => {
    stubPrincipalsEndpoint(() => [alice, bob]);

    renderTypeahead({
      shouldExclude: (p) => p.principalId === bob.principalId,
    });
    const input = screen.getByPlaceholderText("Search or enter email");
    const user = userEvent.setup();

    await user.type(input, "user");

    await waitFor(() => {
      expect(screen.queryAllByRole("option")).toHaveLength(1);
    });
  });

  // Cloudscape Autosuggest renders option labels via CSS pseudo-elements +
  // a screenreader-only sibling, so getByText()/click on role="option" don't
  // drive the component's own selection logic in jsdom. Use the Cloudscape
  // test-utils wrapper, which calls into the same handlers a real user does.
  async function selectSuggestion(principalId: string) {
    const wrapper = createWrapper().findAutosuggest()!;
    await waitFor(() =>
      expect(wrapper.findDropdown().findOptionByValue(principalId)).not.toBe(
        null,
      ),
    );
    wrapper.selectSuggestionByValue(principalId);
  }

  it("calls onSelect immediately when a USER is chosen", async () => {
    stubPrincipalsEndpoint(() => [alice]);

    const { onSelect } = renderTypeahead();
    const input = screen.getByPlaceholderText("Search or enter email");
    const user = userEvent.setup();

    await user.type(input, "alice");
    await selectSuggestion(alice.principalId);

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenCalledWith(alice);
  });

  it("opens a confirmation dialog and onSelect fires only on confirm for GROUP", async () => {
    stubPrincipalsEndpoint(() => [engineering]);

    const { onSelect } = renderTypeahead();
    const input = screen.getByPlaceholderText("Search or enter email");
    const user = userEvent.setup();

    await user.type(input, "eng");
    await selectSuggestion(engineering.principalId);

    expect(
      await screen.findByText(/will receive sandbox access/i),
    ).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Add group" }));

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenCalledWith(engineering);
  });

  it("does not call onSelect when the group confirmation is cancelled", async () => {
    stubPrincipalsEndpoint(() => [engineering]);

    const { onSelect } = renderTypeahead();
    const input = screen.getByPlaceholderText("Search or enter email");
    const user = userEvent.setup();

    await user.type(input, "eng");
    await selectSuggestion(engineering.principalId);

    // Cloudscape Modal stays mounted after dismiss (hidden via CSS class), so
    // assert visibility through the test-utils wrapper instead of a DOM
    // queryByText, which would still find the children.
    await waitFor(() =>
      expect(createWrapper().findModal()?.isVisible()).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(createWrapper().findModal()?.isVisible()).toBe(false),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe("manual resolve (Add button / Enter on unmatched text)", () => {
    /**
     * Triggers manual resolve by setting the Autosuggest value and selecting
     * the enteredTextLabel option ("Add: ..."). This simulates a user typing
     * text and selecting the "use entered value" option from the dropdown.
     */
    async function triggerManualResolve(value: string) {
      const wrapper = createWrapper().findAutosuggest()!;
      wrapper.focus();
      wrapper.setInputValue(value);
      await waitFor(() => {
        expect(wrapper.findEnteredTextOption()).not.toBe(null);
      });
      const enteredTextOption = wrapper.findEnteredTextOption()!;
      enteredTextOption.fireEvent(new MouseEvent("mouseup", { bubbles: true }));
    }

    it("resolves a user by email when Add is clicked", async () => {
      // Return empty from typeahead search so nothing matches
      stubPrincipalsEndpoint(() => []);
      // Stub exact resolve endpoint
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("exact") === "true") {
            return HttpResponse.json({
              status: "success",
              data: { principals: [alice], totalMatches: 1 },
            });
          }
          return HttpResponse.json({
            status: "success",
            data: { principals: [], totalMatches: 0 },
          });
        }),
      );

      const { onSelect } = renderTypeahead();

      await triggerManualResolve("alice@example.com");

      await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
      expect(onSelect).toHaveBeenCalledWith(alice);
    });

    it("shows error when resolve returns 404", async () => {
      stubPrincipalsEndpoint(() => []);
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("exact") === "true") {
            return HttpResponse.json(
              {
                status: "fail",
                data: {
                  errors: [
                    { message: "Principal not found in the identity store." },
                  ],
                },
              },
              { status: 404 },
            );
          }
          return HttpResponse.json({
            status: "success",
            data: { principals: [], totalMatches: 0 },
          });
        }),
      );

      const { onSelect } = renderTypeahead();

      await triggerManualResolve("nobody@example.com");

      await waitFor(() => {
        const formField = createWrapper().findFormField()!;
        expect(formField.findError()?.getElement().textContent).toBeTruthy();
      });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("shows error when principal is already assigned", async () => {
      stubPrincipalsEndpoint(() => []);
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("exact") === "true") {
            return HttpResponse.json({
              status: "success",
              data: { principals: [alice], totalMatches: 1 },
            });
          }
          return HttpResponse.json({
            status: "success",
            data: { principals: [], totalMatches: 0 },
          });
        }),
      );

      const { onSelect } = renderTypeahead({
        shouldExclude: (p) => p.principalId === alice.principalId,
      });

      await triggerManualResolve("alice@example.com");

      await waitFor(() => {
        const formField = createWrapper().findFormField()!;
        expect(formField.findError()?.getElement().textContent).toContain(
          "already assigned",
        );
      });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("uses the latest exclusion rule after an async resolve", async () => {
      let releaseResolve!: () => void;
      let markResolveStarted!: () => void;
      const resolveGate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      const resolveStarted = new Promise<void>((resolve) => {
        markResolveStarted = resolve;
      });
      server.use(
        http.get(
          `${getConfig().ApiUrl}/principals/search`,
          async ({ request }) => {
            const url = new URL(request.url);
            if (url.searchParams.get("exact") === "true") {
              markResolveStarted();
              await resolveGate;
              return HttpResponse.json({
                status: "success",
                data: { principals: [alice], totalMatches: 1 },
              });
            }
            return HttpResponse.json({
              status: "success",
              data: { principals: [], totalMatches: 0 },
            });
          },
        ),
      );

      const onSelect = vi.fn();
      const Wrapper = createQueryClientWrapper();
      const { rerender } = render(
        <Wrapper>
          <PrincipalTypeahead onSelect={onSelect} shouldExclude={() => false} />
        </Wrapper>,
      );

      await triggerManualResolve("alice@example.com");
      await resolveStarted;
      rerender(
        <Wrapper>
          <PrincipalTypeahead
            onSelect={onSelect}
            shouldExclude={(principal) =>
              principal.principalId === alice.principalId
            }
          />
        </Wrapper>,
      );
      releaseResolve();

      await waitFor(() => {
        const formField = createWrapper().findFormField()!;
        expect(formField.findError()?.getElement().textContent).toContain(
          "already assigned",
        );
      });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("does not select a principal if the control is disabled during resolve", async () => {
      let releaseResolve!: () => void;
      let markResolveStarted!: () => void;
      const resolveGate = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      const resolveStarted = new Promise<void>((resolve) => {
        markResolveStarted = resolve;
      });
      server.use(
        http.get(
          `${getConfig().ApiUrl}/principals/search`,
          async ({ request }) => {
            const url = new URL(request.url);
            if (url.searchParams.get("exact") === "true") {
              markResolveStarted();
              await resolveGate;
              return HttpResponse.json({
                status: "success",
                data: { principals: [alice], totalMatches: 1 },
              });
            }
            return HttpResponse.json({
              status: "success",
              data: { principals: [], totalMatches: 0 },
            });
          },
        ),
      );

      const onSelect = vi.fn();
      const Wrapper = createQueryClientWrapper();
      const { rerender } = render(
        <Wrapper>
          <PrincipalTypeahead onSelect={onSelect} />
        </Wrapper>,
      );

      await triggerManualResolve("alice@example.com");
      await resolveStarted;
      rerender(
        <Wrapper>
          <PrincipalTypeahead onSelect={onSelect} disabled />
        </Wrapper>,
      );
      releaseResolve();

      await waitFor(() =>
        expect(createWrapper().findAutosuggest()?.isDisabled()).toBe(true),
      );
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("opens group confirmation when resolving a group name", async () => {
      stubPrincipalsEndpoint(() => []);
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("exact") === "true") {
            return HttpResponse.json({
              status: "success",
              data: { principals: [engineering], totalMatches: 1 },
            });
          }
          return HttpResponse.json({
            status: "success",
            data: { principals: [], totalMatches: 0 },
          });
        }),
      );

      const { onSelect } = renderTypeahead();
      const user = userEvent.setup();

      // "Engineering" has no @, so inferred as group
      await triggerManualResolve("Engineering");

      // Group confirmation modal should appear
      await waitFor(() =>
        expect(createWrapper().findModal()?.isVisible()).toBe(true),
      );
      expect(onSelect).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Add group" }));
      await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
      expect(onSelect).toHaveBeenCalledWith(engineering);
    });

    it("uses 'users' type by default for manual resolve", async () => {
      const recorder = { calls: [] as URL[] };
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
          const url = new URL(request.url);
          recorder.calls.push(url);
          if (url.searchParams.get("exact") === "true") {
            return HttpResponse.json({
              status: "success",
              data: { principals: [alice], totalMatches: 1 },
            });
          }
          return HttpResponse.json({
            status: "success",
            data: { principals: [], totalMatches: 0 },
          });
        }),
      );

      renderTypeahead();

      await triggerManualResolve("alice@example.com");

      await waitFor(() => {
        const exactCall = recorder.calls.find(
          (u) => u.searchParams.get("exact") === "true",
        );
        expect(exactCall).toBeDefined();
        expect(exactCall!.searchParams.get("type")).toBe("users");
      });
    });

    it("uses 'groups' type when Group is selected in segmented control", async () => {
      const recorder = { calls: [] as URL[] };
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
          const url = new URL(request.url);
          recorder.calls.push(url);
          if (url.searchParams.get("exact") === "true") {
            return HttpResponse.json({
              status: "success",
              data: { principals: [engineering], totalMatches: 1 },
            });
          }
          return HttpResponse.json({
            status: "success",
            data: { principals: [], totalMatches: 0 },
          });
        }),
      );

      renderTypeahead();
      const user = userEvent.setup();

      // Switch to Group type
      await user.click(screen.getByText("Group"));

      await triggerManualResolve("Engineering");

      await waitFor(() => {
        const exactCall = recorder.calls.find(
          (u) => u.searchParams.get("exact") === "true",
        );
        expect(exactCall).toBeDefined();
        expect(exactCall!.searchParams.get("type")).toBe("groups");
      });
    });

    it("uses fixed type='users' when component type prop is 'users'", async () => {
      const recorder = { calls: [] as URL[] };
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
          const url = new URL(request.url);
          recorder.calls.push(url);
          if (url.searchParams.get("exact") === "true") {
            return HttpResponse.json({
              status: "success",
              data: { principals: [alice], totalMatches: 1 },
            });
          }
          return HttpResponse.json({
            status: "success",
            data: { principals: [], totalMatches: 0 },
          });
        }),
      );

      renderTypeahead({ type: "users" });

      await triggerManualResolve("alice@example.com");

      await waitFor(() => {
        const exactCall = recorder.calls.find(
          (u) => u.searchParams.get("exact") === "true",
        );
        expect(exactCall).toBeDefined();
        expect(exactCall!.searchParams.get("type")).toBe("users");
      });
    });

    it("uses fixed type='groups' when component type prop is 'groups'", async () => {
      const recorder = { calls: [] as URL[] };
      server.use(
        http.get(`${getConfig().ApiUrl}/principals/search`, ({ request }) => {
          const url = new URL(request.url);
          recorder.calls.push(url);
          if (url.searchParams.get("exact") === "true") {
            return HttpResponse.json({
              status: "success",
              data: { principals: [engineering], totalMatches: 1 },
            });
          }
          return HttpResponse.json({
            status: "success",
            data: { principals: [], totalMatches: 0 },
          });
        }),
      );

      renderTypeahead({ type: "groups" });

      await triggerManualResolve("Engineering");

      await waitFor(() => {
        const exactCall = recorder.calls.find(
          (u) => u.searchParams.get("exact") === "true",
        );
        expect(exactCall).toBeDefined();
        expect(exactCall!.searchParams.get("type")).toBe("groups");
      });
    });
  });

  describe("empty text when principal search is disabled", () => {
    it("shows email-only guidance when type is 'users'", () => {
      renderTypeahead({ enablePrincipalSearch: false, type: "users" });
      const wrapper = createWrapper().findAutosuggest()!;
      wrapper.focus();
      expect(
        screen.getByText("Type an email and press Enter to add"),
      ).toBeInTheDocument();
    });

    it("shows group-only guidance when type is 'groups'", () => {
      renderTypeahead({ enablePrincipalSearch: false, type: "groups" });
      const wrapper = createWrapper().findAutosuggest()!;
      wrapper.focus();
      expect(
        screen.getByText("Type a group name and press Enter to add"),
      ).toBeInTheDocument();
    });

    it("shows both email and group guidance when type is 'all'", () => {
      renderTypeahead({ enablePrincipalSearch: false, type: "all" });
      const wrapper = createWrapper().findAutosuggest()!;
      wrapper.focus();
      expect(
        screen.getByText("Type an email or group name and press Enter to add"),
      ).toBeInTheDocument();
    });
  });
});
