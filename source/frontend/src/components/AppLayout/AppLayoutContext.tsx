// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
} from "react";

interface AppLayoutContextType {
  toolsOpen: boolean;
  setTools: (tools: ReactNode) => void;
  setToolsOpen: (open: boolean) => void;
}

const AppLayoutContext = createContext<AppLayoutContextType | undefined>(
  undefined,
);

export const useAppLayoutContext = (): AppLayoutContextType => {
  const context = useContext(AppLayoutContext);
  if (!context) {
    throw new Error(
      "useAppLayoutContext must be used within an AppLayoutProvider",
    );
  }
  return context;
};

interface AppLayoutProviderProps {
  children: ReactNode;
  toolsOpen: boolean;
  onToolsChange: (open: boolean) => void;
  onToolsContentChange: (tools: ReactNode) => void;
}

export const AppLayoutProvider: React.FC<AppLayoutProviderProps> = ({
  children,
  toolsOpen,
  onToolsChange,
  onToolsContentChange,
}) => {
  const setTools = useCallback(
    (newTools: ReactNode) => {
      onToolsContentChange(newTools);
    },
    [onToolsContentChange],
  );

  const setToolsOpen = useCallback(
    (open: boolean) => {
      onToolsChange(open);
    },
    [onToolsChange],
  );

  const value = useMemo(
    () => ({
      toolsOpen,
      setTools,
      setToolsOpen,
    }),
    [toolsOpen, setTools, setToolsOpen],
  );

  return (
    <AppLayoutContext.Provider value={value}>
      {children}
    </AppLayoutContext.Provider>
  );
};
