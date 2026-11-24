#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Prints the agent runtime image's source tag, for scripts/cdk/deploy.sh and
// scripts/docker. Run with `npm run --silent agent-runtime:source-tag`.
import { agentRuntimeSourceTag } from "@amzn/innovation-sandbox-infrastructure/components/sandbox-agent/agent-runtime-image";

process.stdout.write(`${agentRuntimeSourceTag()}\n`);
