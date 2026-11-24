// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Duration } from "aws-cdk-lib";

/**
 * How often TokenPoll runs. The poll's timeout is derived from it so a run
 * never outlasts the next tick, and its alarms evaluate one period per tick.
 */
export const TOKEN_POLL_INTERVAL = Duration.minutes(10);
