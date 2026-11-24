// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  AgentModelAdminUpdate,
  AgentModelCreate,
  PersistedAgentModelCatalogRow,
} from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import {
  PersistedConfigSectionData,
  PersistedLastSavedBy,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";
import {
  ConfigSchemas,
  ConfigSection,
  ConfigWriteSchemas,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

/**
 * Thrown by `putSection` on an optimistic-concurrency conflict.
 * The PUT handler maps this to 409 and MUST NOT surface `error.message` to the client.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Read/write contract for the config sections and agent-model catalog,
 * backed by the Config DynamoDB table.
 */
export interface ConfigStore {
  /**
   * Returns the section, or `null` if absent.
   * @param options.consistentRead - When true, uses a strongly consistent read.
   */
  getSection<T extends ConfigSection>(
    section: T,
    options?: { consistentRead?: boolean },
  ): Promise<PersistedConfigSectionData<T> | null>;

  /** Returns only sections present in DynamoDB; callers default the rest. */
  getAllSections(): Promise<{
    [K in ConfigSection]?: PersistedConfigSectionData<K>;
  }>;

  /**
   * Writes a section with optimistic concurrency. Sets `lastSavedBy`,
   * `meta.lastEditTime`, and `meta.schemaVersion` server-side.
   *
   * Implementations MUST call `PersistedLastSavedBySchema.parse(editedBy)` before writing.
   *
   * @throws {ConflictError} when the condition expression fails.
   */
  putSection<T extends ConfigSection>(
    section: T,
    data: z.infer<(typeof ConfigWriteSchemas)[T]>,
    editedBy: PersistedLastSavedBy,
    expectedLastEditTime?: string,
  ): Promise<PersistedConfigSectionData<T>>;

  /**
   * Writes all supplied sections atomically. Idempotent — each section is
   * guarded with `attribute_not_exists`, so a re-invocation is a no-op
   * (`{ migrated: false }`) rather than overwriting admin-saved config.
   *
   * Implementations MUST call `PersistedLastSavedBySchema.parse(editedBy)` before writing.
   */
  migrateSections(
    sections: { [K in ConfigSection]?: z.infer<(typeof ConfigSchemas)[K]> },
    editedBy: PersistedLastSavedBy,
  ): Promise<{ migrated: boolean }>;

  /**
   * Returns all catalog rows. Corrupt or version-mismatched rows are dropped.
   * @param options.consistentRead - When true, uses a strongly consistent read.
   */
  getAgentModels(options?: {
    consistentRead?: boolean;
  }): Promise<PersistedAgentModelCatalogRow[]>;

  /** Returns one catalog row by modelId, or undefined when absent or invalid. */
  getAgentModel(
    modelId: string,
  ): Promise<PersistedAgentModelCatalogRow | undefined>;

  /**
   * Returns a page of catalog rows. Corrupt rows are dropped (fail-open).
   * `nextPageIdentifier` is `null` when the last page has been reached.
   */
  getAgentModelsPaginated(props: {
    pageSize?: number;
    pageIdentifier?: string;
  }): Promise<{
    rows: PersistedAgentModelCatalogRow[];
    nextPageIdentifier: string | null;
  }>;

  /**
   * Add-only discovery write. A re-fetch never overwrites an existing row.
   * @throws {ConflictError} when the row already exists.
   */
  putModelRow(
    row: AgentModelCreate,
    addedBy: PersistedLastSavedBy,
  ): Promise<PersistedAgentModelCatalogRow>;

  /**
   * Admin enable/disable toggle. OCC-guarded on `meta.lastEditTime`.
   * @throws {ConflictError} when the condition fails (stale token).
   */
  updateModelAdminFields(
    modelId: string,
    update: AgentModelAdminUpdate,
    editedBy: PersistedLastSavedBy,
    expectedLastEditTime: string,
  ): Promise<PersistedAgentModelCatalogRow>;
}
