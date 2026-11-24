// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

import { UserSelectionForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/UserSelectionForm";

vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead",
  () => ({
    PrincipalTypeahead: ({
      onSelect,
    }: {
      onSelect: (principal: {
        principalId: string;
        principalType: "USER";
        displayName: string;
        email: string;
      }) => void;
    }) => (
      <button
        type="button"
        onClick={() =>
          onSelect({
            principalId: "new-owner",
            principalType: "USER",
            displayName: "New Owner",
            email: "new-owner@example.com",
          })
        }
      >
        Select new owner
      </button>
    ),
  }),
);

type FormValues = {
  selectedUser?: {
    principalId: string;
    email: string;
    displayName?: string;
  };
  assignments?: Array<{
    principalId: string;
    principalType: "USER";
  }>;
};

describe("UserSelectionForm", () => {
  it("clears staged assignments when the prospective owner changes", async () => {
    const captured: { values?: FormValues } = {};

    const Harness = () => {
      const methods = useForm<FormValues>({
        defaultValues: {
          selectedUser: {
            principalId: "old-owner",
            email: "old-owner@example.com",
            displayName: "Old Owner",
          },
          assignments: [{ principalId: "shared-user", principalType: "USER" }],
        },
      });
      const values = methods.watch();
      useEffect(() => {
        captured.values = values;
      });

      return (
        <FormProvider {...methods}>
          <UserSelectionForm clearAssignmentsOnChange />
        </FormProvider>
      );
    };

    render(<Harness />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Select new owner" }));

    expect(captured.values).toMatchObject({
      selectedUser: {
        principalId: "new-owner",
        email: "new-owner@example.com",
        displayName: "New Owner",
      },
    });
    expect(captured.values?.assignments).toBeUndefined();
  });
});
