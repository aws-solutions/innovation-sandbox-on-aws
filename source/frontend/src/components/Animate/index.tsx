// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AnimatePresence, HTMLMotionProps, motion } from "framer-motion";
import React from "react";

const AnimationTypes: Record<string, HTMLMotionProps<"div">> = {
  SlideLeft: {
    initial: { x: "40vw", opacity: 0 },
    animate: { x: 0, opacity: 1 },
    transition: { type: "spring", duration: 0.35 },
  },
  SlideRight: {
    initial: { x: "-40vw", opacity: 0 },
    animate: { x: 0, opacity: 1 },
    transition: { type: "spring", duration: 0.35 },
  },
  FadeIn: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.35 },
  },
  SlideDown: {
    initial: { height: 0, opacity: 0 },
    animate: { height: "auto", opacity: 1 },
    transition: { type: "spring", duration: 0.2 },
  },
};

type AnimationType =
  "SlideLeft" | "SlideRight" | "FadeIn" | "SlideDown" | "None";

interface AnimateProps {
  isHidden?: boolean;
  animationType?: AnimationType;
  children: React.ReactNode;
}

export default function Animate({
  isHidden,
  animationType,
  children,
}: Readonly<AnimateProps>) {
  // default animation = fade in
  const type = animationType
    ? AnimationTypes[animationType]
    : AnimationTypes.FadeIn;

  return (
    <AnimatePresence>
      {!isHidden && (
        <motion.div key={isHidden ? "false" : "true"} {...type}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
