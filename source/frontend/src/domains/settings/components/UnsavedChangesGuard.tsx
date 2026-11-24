// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Modal,
  SpaceBetween,
} from "@cloudscape-design/components";
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useBlocker } from "react-router-dom";

const UnsavedChangesContext = createContext<
  (id: string, dirty: boolean) => void
>(() => {});

// The set of currently-dirty section ids, exposed separately from the reporter
// so consumers that only read (e.g. the tab dirty indicator) don't need the
// callback. Defaults to an empty set for components rendered outside a provider.
const DirtySectionsContext = createContext<ReadonlySet<string>>(new Set());

export function useTrackUnsavedChanges(id: string, dirty: boolean) {
  const reportDirty = useContext(UnsavedChangesContext);
  useEffect(() => {
    reportDirty(id, dirty);
    return () => reportDirty(id, false);
  }, [id, dirty, reportDirty]);
}

/** The set of section ids with unsaved (dirty) edits. */
export function useDirtySections(): ReadonlySet<string> {
  return useContext(DirtySectionsContext);
}

function RouteChangeGuard({
  hasUnsavedChanges,
}: Readonly<{
  hasUnsavedChanges: boolean;
}>) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasUnsavedChanges && currentLocation.pathname !== nextLocation.pathname,
  );

  if (blocker.state !== "blocked") {
    return null;
  }
  return (
    <Modal
      visible
      onDismiss={() => blocker.reset()}
      header="Leave page?"
      closeAriaLabel="Close"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => blocker.reset()}>
              Stay
            </Button>
            <Button variant="primary" onClick={() => blocker.proceed()}>
              Leave
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      You have unsaved changes. If you leave this page, your changes will be
      lost.
    </Modal>
  );
}

function BeforeUnloadGuard({
  hasUnsavedChanges,
}: {
  hasUnsavedChanges: boolean;
}) {
  useEffect(() => {
    if (!hasUnsavedChanges) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true; // NOSONAR typescript:S1874: Preserve the unsaved-changes warning in legacy browsers.
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges]);
  return null;
}

/**
 * Requires a data router (the app uses createBrowserRouter) — useBlocker
 * throws under a plain BrowserRouter/MemoryRouter, so tests must render
 * with createMemoryRouter + RouterProvider.
 */
export function UnsavedChangesProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [dirtySections, setDirtySections] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const reportDirty = useCallback((id: string, dirty: boolean) => {
    setDirtySections((prev) => {
      if (prev.has(id) === dirty) {
        return prev;
      }
      const next = new Set(prev);
      if (dirty) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);
  const hasUnsavedChanges = dirtySections.size > 0;

  return (
    <UnsavedChangesContext.Provider value={reportDirty}>
      <DirtySectionsContext.Provider value={dirtySections}>
        {children}
        <RouteChangeGuard hasUnsavedChanges={hasUnsavedChanges} />
        <BeforeUnloadGuard hasUnsavedChanges={hasUnsavedChanges} />
      </DirtySectionsContext.Provider>
    </UnsavedChangesContext.Provider>
  );
}
