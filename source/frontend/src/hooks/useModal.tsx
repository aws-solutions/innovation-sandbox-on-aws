// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Modal } from "@cloudscape-design/components";
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export type ModalProps = {
  header?: ReactNode;
  content: ReactNode;
  footer?: ReactNode;
  size?: "small" | "medium" | "large" | "max";
};

type ModalContextType = {
  showModal: (props: ModalProps) => void;
  hideModal: () => void;
};

type ModalProviderProps = {
  children: ReactNode;
};

const ModalContext = createContext<ModalContextType | undefined>(undefined);

export const ModalProvider = ({ children }: ModalProviderProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const [modalProps, setModalProps] = useState<ModalProps | null>(null);

  const showModal = useCallback((props: ModalProps) => {
    setModalProps(props);
    setIsVisible(true);
  }, []);

  const hideModal = useCallback(() => {
    setIsVisible(false);
    setModalProps(null);
  }, []);

  const contextValue = useMemo(
    () => ({ showModal, hideModal }),
    [showModal, hideModal],
  );

  return (
    <ModalContext.Provider value={contextValue}>
      {children}
      <Modal
        visible={isVisible}
        onDismiss={() => hideModal()}
        header={modalProps?.header}
        footer={modalProps?.footer}
        size={modalProps?.size}
      >
        {modalProps?.content}
      </Modal>
    </ModalContext.Provider>
  );
};

export const useModal = () => {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error("useModal must be used within a ModalProvider");
  }
  return context;
};
