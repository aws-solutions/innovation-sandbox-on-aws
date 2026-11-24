// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Grid,
  Header,
  Modal,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";
import {
  Fragment,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { DefaultSettingsAlert } from "@amzn/innovation-sandbox-frontend/domains/settings/components/DefaultSettingsAlert";
import { LastSavedDescription } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/LastSavedDescription";
import { useSettingsGroups } from "@amzn/innovation-sandbox-frontend/domains/settings/components/groups/useSettingsGroups";
import { SettingsFormContext } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsFormContext";
import { SettingsNavigation } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsNavigation";
import { UnsavedChangesProvider } from "@amzn/innovation-sandbox-frontend/domains/settings/components/UnsavedChangesGuard";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { AdminConfigurationView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import {
  SETTINGS_GROUPS,
  settingsGroupHref,
  SettingsGroupId,
} from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import { resolveSettingsHash } from "@amzn/innovation-sandbox-frontend/domains/settings/settings-search";
import { ConfigurationForm } from "@amzn/innovation-sandbox-frontend/domains/settings/useConfigurationForm";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

export const GROUP_HELP = Object.fromEntries(
  SETTINGS_GROUPS.map((group) => [group.id, group.help]),
) as Record<SettingsGroupId, string>;
type Selection = { group: SettingsGroupId; target?: string };

function getBlockedReason(state: ReturnType<ConfigurationForm["status"]>) {
  if (state.conflict) return "Reload latest values before saving.";
  if (state.invalid) return "Fix validation errors before saving.";
  if (!state.dirty && !state.needsSetup) return "No changes to save.";
  return undefined;
}

function SettingsContent({
  config,
}: Readonly<{ config: AdminConfigurationView }>) {
  const { isAdmin } = useUser();
  const { setTools } = useAppLayoutContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [selection, setSelection] = useState<Selection>(() =>
    resolveSettingsHash(location.hash.slice(1)),
  );
  const { group: activeGroup } = selection;
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Selection | "cancel" | null>(null);
  const [confirmation, setConfirmation] = useState<{
    message: ReactNode;
    onSaved?: () => void;
  } | null>(null);
  const [operationInProgress, setOperationInProgress] = useState(false);
  const consumedLocation = useRef(location.key);
  const { groups, sections } = useSettingsGroups(config);
  // Page operations also cover preflight checks and requests owned by each group.
  const busy =
    operationInProgress || Object.values(groups).some((group) => group.busy);
  const interactionBlocked = busy || !!confirmation;
  const formContext = useMemo(
    () => ({ sections, busy: interactionBlocked }),
    [sections, interactionBlocked],
  );
  const activeController = groups[activeGroup];
  const status = (group: SettingsGroupId) => ({
    needsSetup: isAdmin && groups[group].status().needsSetup,
  });
  const state = activeController.status();
  const group = SETTINGS_GROUPS.find((group) => group.id === activeGroup)!;
  const blockedReason = getBlockedReason(state);
  const applySelection = (selection: Selection) => {
    setSelection(selection);
    setQuery("");
    const hash = selection.target ?? selection.group;
    if (location.hash !== `#${hash}`)
      navigate(
        selection.target
          ? `/settings#${selection.target}`
          : settingsGroupHref(selection.group),
      );
  };
  const choose = (selection: Selection) => {
    if (interactionBlocked) return;
    if (selection.group !== activeGroup && isAdmin && state.dirty)
      setPending(selection);
    else applySelection(selection);
  };
  useEffect(() => {
    setTools(<Markdown file={GROUP_HELP[activeGroup]} />);
  }, [activeGroup]);
  useEffect(() => {
    // Leave blocked history navigation unconsumed so it resumes after the operation.
    if (interactionBlocked || consumedLocation.current === location.key) return;
    consumedLocation.current = location.key;
    choose(resolveSettingsHash(location.hash.slice(1)));
  }, [location.key, interactionBlocked]);
  useEffect(() => {
    const target = selection.target;
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(target);
      element?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      (
        element?.querySelector<HTMLElement>(
          "input, textarea, button, select, [tabindex='0']",
        ) ?? element
      )?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [selection]);
  const discard = () => activeController.discard();
  const performSave = async (onSaved?: () => void) => {
    setOperationInProgress(true);
    try {
      if (await activeController.save()) {
        showSuccessToast("Settings saved.");
        onSaved?.();
      }
    } finally {
      setOperationInProgress(false);
    }
  };
  const save = async (onSaved?: () => void) => {
    if (interactionBlocked) return;
    if (!activeController.validate() || state.conflict) return;
    setOperationInProgress(true);
    try {
      const warning = await activeController.getSaveWarning?.();
      if (warning) setConfirmation({ message: warning, onSaved });
      else await performSave(onSaved);
    } catch (error) {
      showErrorToast(
        error instanceof Error ? error.message : "Unable to prepare settings.",
        "Save not started",
      );
    } finally {
      setOperationInProgress(false);
    }
  };
  const mostRecent = activeController.audit
    .filter((section) => section.lastSavedBy)
    .sort(
      (a, b) =>
        (DateTime.fromISO(b.meta?.lastEditTime ?? "").toMillis() || 0) -
        (DateTime.fromISO(a.meta?.lastEditTime ?? "").toMillis() || 0),
    )[0];
  const reload = async () => {
    if (interactionBlocked) return;
    setOperationInProgress(true);
    try {
      await activeController.reload();
    } finally {
      setOperationInProgress(false);
    }
  };
  return (
    <SettingsFormContext.Provider value={formContext}>
      <SpaceBetween size="l">
        <Grid
          gridDefinition={[
            { colspan: { default: 12, s: 3 } },
            { colspan: { default: 12, s: 9 } },
          ]}
        >
          <SettingsNavigation
            activeGroup={activeGroup}
            query={query}
            onQueryChange={setQuery}
            onSelect={choose}
            status={status}
          />
          <section aria-label={`${group.label} settings`}>
            <SpaceBetween size="l">
              <Header
                variant="h2"
                description={group.description}
                info={<InfoLink markdown={group.help} />}
              >
                {group.label}
              </Header>
              {isAdmin && state.needsSetup && <DefaultSettingsAlert />}
              {SETTINGS_GROUPS.map(({ id }) => (
                <Fragment key={id}>
                  {groups[id].render(id === activeGroup, interactionBlocked)}
                </Fragment>
              ))}
              <Box padding={{ bottom: "l" }}>
                <section
                  aria-label={`${group.label} ${isAdmin ? "save bar" : "footer"}`}
                >
                  <Grid
                    gridDefinition={
                      isAdmin && (state.invalid || state.conflict)
                        ? [
                            { colspan: { default: 12, s: 6 } },
                            { colspan: { default: 12, s: 6 } },
                          ]
                        : [{ colspan: 12 }]
                    }
                  >
                    {isAdmin && (state.invalid || state.conflict) && (
                      <StatusIndicator
                        type={state.conflict ? "warning" : "error"}
                        nativeAttributes={{ role: "status" }}
                      >
                        {blockedReason}
                      </StatusIndicator>
                    )}
                    <SpaceBetween size="s">
                      <Box textAlign={isAdmin ? "right" : "left"}>
                        <section aria-label={`${group.label} last edited`}>
                          <LastSavedDescription
                            data={mostRecent ?? { lastSavedBy: null }}
                          />
                        </section>
                      </Box>
                      {isAdmin && (
                        <Box float="right">
                          <SpaceBetween direction="horizontal" size="xs">
                            {state.conflict && (
                              <Button
                                formAction="none"
                                onClick={reload}
                                disabled={interactionBlocked}
                              >
                                Reload latest values
                              </Button>
                            )}
                            <Button
                              variant="link"
                              disabled={!state.dirty || interactionBlocked}
                              onClick={() => setPending("cancel")}
                            >
                              Cancel
                            </Button>
                            <Button
                              variant="primary"
                              loading={busy}
                              disabled={interactionBlocked || !!blockedReason}
                              disabledReason={blockedReason}
                              onClick={() => void save()}
                            >
                              Save changes
                            </Button>
                          </SpaceBetween>
                        </Box>
                      )}
                    </SpaceBetween>
                  </Grid>
                </section>
              </Box>
            </SpaceBetween>
          </section>
        </Grid>
      </SpaceBetween>
      {pending !== null && (
        <Modal
          visible
          header={
            pending === "cancel"
              ? "Discard unsaved changes?"
              : "Unsaved changes"
          }
          closeAriaLabel="Close"
          onDismiss={() => {
            setPending(null);
            navigate(settingsGroupHref(activeGroup), { replace: true });
          }}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="link"
                  onClick={() => {
                    setPending(null);
                    navigate(settingsGroupHref(activeGroup), { replace: true });
                  }}
                >
                  Keep editing
                </Button>
                <Button
                  disabled={interactionBlocked}
                  onClick={() => {
                    const selection = pending;
                    discard();
                    setPending(null);
                    if (selection && selection !== "cancel")
                      applySelection(selection);
                  }}
                >
                  Discard changes
                </Button>
                {pending !== "cancel" && (
                  <Button
                    variant="primary"
                    disabled={
                      interactionBlocked || state.invalid || state.conflict
                    }
                    onClick={() => {
                      const selection = pending;
                      setPending(null);
                      void save(() => {
                        if (selection) applySelection(selection);
                      });
                    }}
                  >
                    Save changes
                  </Button>
                )}
              </SpaceBetween>
            </Box>
          }
        >
          You have unsaved changes in {group.label}.
        </Modal>
      )}
      {confirmation !== null && (
        <Modal
          visible
          header="Confirm settings changes"
          closeAriaLabel="Close"
          onDismiss={() => setConfirmation(null)}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setConfirmation(null)}>
                  Keep editing
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    const action = confirmation?.onSaved;
                    setConfirmation(null);
                    void performSave(action);
                  }}
                >
                  Save changes
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          {confirmation.message}
        </Modal>
      )}
    </SettingsFormContext.Provider>
  );
}

export function AdminSettings() {
  const setBreadcrumb = useBreadcrumb();
  const {
    data: config,
    isLoading,
    isFetching,
    refetch,
    error,
  } = useGetConfigurations();
  const user = useUser();
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Settings", href: "/settings" },
    ]);
  }, []);
  const renderContent = () => {
    if (isLoading || user.isLoading) return <Loader />;
    if (config) return <SettingsContent config={config} />;
    return (
      <ErrorPanel
        description="There was a problem loading settings."
        retry={refetch}
        error={error as Error}
      />
    );
  };
  return (
    <UnsavedChangesProvider>
      <ContentLayout
        header={
          <Header
            variant="h1"
            description="Deployment-wide configuration for Innovation Sandbox."
            actions={
              <Button
                iconName="refresh"
                ariaLabel="Refresh settings"
                disabled={isFetching}
                onClick={() => refetch()}
              />
            }
          >
            Settings
          </Header>
        }
      >
        {renderContent()}
      </ContentLayout>
    </UnsavedChangesProvider>
  );
}
