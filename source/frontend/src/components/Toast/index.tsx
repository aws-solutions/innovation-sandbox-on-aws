// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import classNames from "classnames";
import type { ReactNode } from "react";
import { Flip, toast } from "react-toastify/unstyled";

import styles from "./styles.module.scss";

interface ToastMessageProps {
  description: ReactNode;
  title?: string;
}

const ToastMessage = ({ description, title }: ToastMessageProps) => {
  return (
    <div className={styles.container}>
      {title && <div className={styles.title}>{title}</div>}
      <div className={styles.description}>{description}</div>
    </div>
  );
};

const commonSettings = {
  autoClose: 5000,
  className: styles.toast,
  hideProgressBar: false,
  closeOnClick: false,
  pauseOnHover: true,
  draggable: true,
  progress: undefined,
  theme: "colored",
  transition: Flip,
};

export const showErrorToast = (description: ReactNode, title?: string) => {
  toast.error(<ToastMessage description={description} title={title} />, {
    ...commonSettings,
    autoClose: false,
    position: "bottom-right",
    className: classNames(styles.toast, styles.error),
  });
};

export const showSuccessToast = (description: ReactNode, title?: string) => {
  toast.success(<ToastMessage description={description} title={title} />, {
    ...commonSettings,
    className: classNames(styles.toast, styles.success, styles.top),
    autoClose: 3000,
    position: "top-right",
  });
};
