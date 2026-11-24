// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Autosuggest,
  Box,
  Icon,
  SideNavigation,
  Tooltip,
} from "@cloudscape-design/components";
import { useEffect, useId, useRef, useState } from "react";

import {
  SETTINGS_GROUPS,
  settingsGroupHref,
  SettingsGroupId,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import { searchSettings } from "@amzn/innovation-sandbox-frontend/domains/settings/settings-search";

const DEFAULT_SETTINGS_REVIEW_MESSAGE =
  "Default settings have not been saved. Review the values, then save these settings.";

function ReviewIndicator({
  label,
  needsReview,
  focused,
}: Readonly<{
  label: string;
  needsReview: boolean;
  focused: boolean;
}>) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const descriptionId = useId();
  const [showTooltip, setShowTooltip] = useState(false);
  useEffect(
    () => setShowTooltip(focused && needsReview),
    [focused, needsReview],
  );
  if (!needsReview) return <Icon variant="link" />;
  return (
    <>
      <span
        ref={triggerRef}
        onPointerEnter={() => setShowTooltip(true)}
        onPointerLeave={() => setShowTooltip(false)}
      >
        <Icon
          name="status-info"
          variant="link"
          ariaLabel={`${label}: default settings have not been saved`}
          nativeAttributes={{ "aria-describedby": descriptionId }}
        />
      </span>
      <span id={descriptionId} hidden>
        {DEFAULT_SETTINGS_REVIEW_MESSAGE}
      </span>
      {showTooltip && (
        <Tooltip
          content={DEFAULT_SETTINGS_REVIEW_MESSAGE}
          getTrack={() => triggerRef.current}
          onEscape={() => setShowTooltip(false)}
        />
      )}
    </>
  );
}

export function SettingsNavigation({
  activeGroup,
  query,
  onQueryChange,
  onSelect,
  status,
}: Readonly<{
  activeGroup: SettingsGroupId;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (selection: { group: SettingsGroupId; target?: string }) => void;
  status: (group: SettingsGroupId) => {
    needsSetup: boolean;
  };
}>) {
  const [focusedHref, setFocusedHref] = useState<string>();
  const results = searchSettings(query);
  return (
    <nav
      aria-label="Settings groups"
      // Use the section link's focus rather than adding a tab stop to its icon.
      onFocus={({ target }) =>
        setFocusedHref(target.closest("a")?.getAttribute("href") ?? undefined)
      }
      onBlur={() => setFocusedHref(undefined)}
    >
      <SideNavigation
        activeHref={settingsGroupHref(activeGroup)}
        itemsControl={
          <Box margin={{ bottom: "s" }}>
            <Autosuggest
              value={query}
              options={results.map((field) => ({
                value: field.id,
                label: field.label,
                description: `${
                  SETTINGS_GROUPS.find((group) => group.id === field.group)!
                    .label
                } › ${field.subgroup}`,
              }))}
              filteringType="manual"
              hideEnteredTextOption
              placeholder="Find a setting"
              ariaLabel="Find a setting"
              clearAriaLabel="Clear setting search"
              selectedAriaLabel="Selected"
              filteringResultsText={() =>
                results.length
                  ? `${results.length} matches`
                  : "No settings found."
              }
              onChange={({ detail }) => onQueryChange(detail.value)}
              onSelect={({ detail }) => {
                const field = results.find(
                  (field) => field.id === detail.value,
                );
                if (field) {
                  onQueryChange("");
                  onSelect({ group: field.group, target: field.id });
                }
              }}
            />
          </Box>
        }
        items={SETTINGS_GROUPS.map((group) => {
          const needsReview = status(group.id).needsSetup;
          return {
            type: "link",
            text: group.label,
            href: settingsGroupHref(group.id),
            info: (
              <ReviewIndicator
                label={group.label}
                needsReview={needsReview}
                focused={focusedHref === settingsGroupHref(group.id)}
              />
            ),
          };
        })}
        onFollow={(event) => {
          event.preventDefault();
          const group = SETTINGS_GROUPS.find(
            (group) => event.detail.href === settingsGroupHref(group.id),
          );
          if (group) onSelect({ group: group.id });
        }}
      />
    </nav>
  );
}
