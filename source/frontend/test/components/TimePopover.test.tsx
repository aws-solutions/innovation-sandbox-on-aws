// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, render } from "@testing-library/react";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TimePopover } from "@amzn/innovation-sandbox-frontend/components/TimePopover";
import { formatRelativeTime } from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

describe("TimePopover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("shows the relative time and opens to the full absolute time", () => {
    const time = "2024-06-15T09:00:00.000Z";

    const { container } = render(<TimePopover time={time} />);

    const popover = createWrapper(container).findPopover()!;
    expect(popover.findTrigger().getElement()).toHaveTextContent(
      formatRelativeTime(time),
    );

    act(() => popover.findTrigger().click());

    expect(popover.findContent()!.getElement()).toHaveTextContent(
      DateTime.fromISO(time).toLocaleString(DateTime.DATETIME_HUGE),
    );
  });

  test("shows the raw value when the time cannot be parsed", () => {
    const { container } = render(<TimePopover time="not-a-time" />);

    expect(
      createWrapper(container).findPopover()!.findTrigger().getElement(),
    ).toHaveTextContent("not-a-time");
  });
  test("opens to the raw value when the time cannot be parsed", () => {
    const { container } = render(<TimePopover time="not-a-time" />);
    const popover = createWrapper(container).findPopover()!;
    act(() => popover.findTrigger().click());
    const content = popover.findContent()!.getElement();
    expect(content).toHaveTextContent("not-a-time");
    expect(content).not.toHaveTextContent("Invalid DateTime");
  });
});
