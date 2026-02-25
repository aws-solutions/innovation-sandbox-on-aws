// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CloudFormationClient,
  ConcurrencyMode,
  DeleteStackInstancesCommand,
  DescribeStackSetCommand,
  DescribeStackSetCommandOutput,
  ListStackSetsCommand,
  PermissionModels,
  RegionConcurrencyType,
  StackSet,
  StackSetNotFoundException,
  StackSetStatus,
} from "@aws-sdk/client-cloudformation";

import {
  BLUEPRINT_SK,
  generateBlueprintPK,
  generateStackSetSK,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-dynamodb-keys.js";
import { type BlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import {
  type BlueprintItem,
  type BlueprintWithStackSets,
  type StackSetItem,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { type LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import { searchableBlueprintProperties } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { randomUUID } from "crypto";

const logger = new Logger();

export class StackSetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackSetNotFoundError";
  }
}

export class UnsupportedPermissionModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPermissionModelError";
  }
}

export class BlueprintInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintInUseError";
  }
}

interface ValidationResult {
  isValid: boolean;
  stackSet?: StackSet;
  errorMessage?: string;
  errorType?:
    | "NOT_FOUND"
    | "UNSUPPORTED_PERMISSION_MODEL"
    | "INVALID_STATUS"
    | "INVALID_ROLE";
}

export class BlueprintDeploymentService {
  /**
   * Deployment orchestration is handled via EventBridge → Step Functions (event-driven pattern).
   */
  constructor(
    private readonly cloudFormationClient: CloudFormationClient,
    private readonly env: {
      INTERMEDIATE_ROLE_ARN: string;
      SANDBOX_ACCOUNT_ROLE_NAME: string;
      ORG_MGT_ACCOUNT_ID: string;
      HUB_ACCOUNT_ID: string;
    },
  ) {}

  async registerBlueprint(
    props: {
      name: string;
      stackSetId: string;
      regions: string[];
      tags?: Record<string, string>;
      deploymentTimeoutMinutes?: number;
      regionConcurrencyType?: RegionConcurrencyType;
      maxConcurrentPercentage?: number;
      failureTolerancePercentage?: number;
      concurrencyMode?: ConcurrencyMode;
      createdBy: string;
    },
    blueprintStore: BlueprintStore,
  ): Promise<BlueprintItem> {
    const {
      name,
      stackSetId,
      regions,
      tags,
      deploymentTimeoutMinutes,
      regionConcurrencyType,
      maxConcurrentPercentage,
      failureTolerancePercentage,
      concurrencyMode,
      createdBy,
    } = props;

    logger.info(
      `Registering new blueprint (${name}) with StackSet ID (${stackSetId})`,
    );

    const validationResult = await this.validateStackSet(stackSetId);
    if (!validationResult.isValid) {
      if (validationResult.errorType === "UNSUPPORTED_PERMISSION_MODEL") {
        throw new UnsupportedPermissionModelError(
          validationResult.errorMessage!,
        );
      }
      throw new Error(validationResult.errorMessage);
    }

    const stackSet = validationResult.stackSet!;

    const blueprintId = randomUUID();

    const blueprint: BlueprintItem = {
      PK: generateBlueprintPK(blueprintId),
      SK: BLUEPRINT_SK,
      itemType: "BLUEPRINT",
      blueprintId,
      name,
      tags,
      createdBy,
      deploymentTimeoutMinutes: deploymentTimeoutMinutes ?? 30,
      regionConcurrencyType: regionConcurrencyType ?? "SEQUENTIAL",
      totalHealthMetrics: {
        totalDeploymentCount: 0,
        totalSuccessfulCount: 0,
      },
    };

    if (!stackSet.AdministrationRoleARN || !stackSet.ExecutionRoleName) {
      throw new Error(
        "StackSet is missing required role configuration (AdministrationRoleARN or ExecutionRoleName).",
      );
    }

    const stackSetItem: StackSetItem = {
      PK: generateBlueprintPK(blueprintId),
      SK: generateStackSetSK(stackSetId),
      itemType: "STACKSET",
      blueprintId,
      stackSetId,
      administrationRoleArn: stackSet.AdministrationRoleARN,
      executionRoleName: stackSet.ExecutionRoleName,
      regions,
      deploymentOrder: 1,
      maxConcurrentPercentage: maxConcurrentPercentage ?? 100,
      failureTolerancePercentage: failureTolerancePercentage ?? 0,
      concurrencyMode: concurrencyMode ?? "STRICT_FAILURE_TOLERANCE",
      healthMetrics: {
        deploymentCount: 0,
        successfulDeploymentCount: 0,
        consecutiveFailures: 0,
      },
    };

    const result = await blueprintStore.createBlueprintWithStackSet(
      blueprint,
      stackSetItem,
    );

    logger.info(
      `Blueprint registered successfully (${result.blueprint.name}) (${result.blueprint.blueprintId})`,
      searchableBlueprintProperties(result),
    );

    return result.blueprint;
  }

  async unregisterBlueprint(
    props: {
      blueprint: BlueprintItem;
    },
    blueprintStore: BlueprintStore,
    leaseTemplateStore: LeaseTemplateStore,
  ): Promise<void> {
    const { blueprint } = props;

    logger.info(
      `Unregistering blueprint (${blueprint.name}) (${blueprint.blueprintId})`,
      searchableBlueprintProperties({ blueprint, stackSets: [] }),
    );

    await this.validateBlueprintNotInUse(
      blueprint.blueprintId,
      leaseTemplateStore,
    );

    await blueprintStore.delete({ blueprintId: blueprint.blueprintId });

    logger.info(
      `Blueprint unregistered successfully (${blueprint.name}) (${blueprint.blueprintId})`,
    );
  }

  private async getStackSet(stackSetId: string): Promise<StackSet> {
    try {
      const command = new DescribeStackSetCommand({
        StackSetName: stackSetId, // Accepts name or ID per AWS API
      });
      const stackSetResponse: DescribeStackSetCommandOutput =
        await this.cloudFormationClient.send(command);

      const stackSet = stackSetResponse.StackSet!;

      if (stackSet.Status === StackSetStatus.DELETED) {
        throw new StackSetNotFoundError(
          "StackSet has been deleted. Please verify the StackSet exists and try again.",
        );
      }

      return stackSet;
    } catch (error) {
      if (error instanceof StackSetNotFoundException) {
        throw new StackSetNotFoundError(
          "StackSet not found or has been deleted. Please verify the StackSet exists and try again.",
        );
      }
      // Let other errors (network, permissions, throttling, etc.) bubble up with original error type
      throw error;
    }
  }

  private validatePermissionModel(stackSet: StackSet): ValidationResult {
    // Check explicit SERVICE_MANAGED
    if (stackSet.PermissionModel === PermissionModels.SERVICE_MANAGED) {
      return {
        isValid: false,
        errorMessage:
          "Only SELF_MANAGED StackSets are supported for blueprint registration.",
        errorType: "UNSUPPORTED_PERMISSION_MODEL",
      };
    }

    // When PermissionModel is null (member accounts), check AdministrationRoleARN
    // SERVICE_MANAGED StackSets (like Control Tower) use specific role patterns
    if (!stackSet.PermissionModel && stackSet.AdministrationRoleARN) {
      const isControlTowerStackSet = stackSet.AdministrationRoleARN.includes(
        "AWSControlTowerStackSetRole",
      );
      const isServiceManagedPattern =
        stackSet.AdministrationRoleARN.includes("/service-role/");

      if (isControlTowerStackSet || isServiceManagedPattern) {
        return {
          isValid: false,
          errorMessage:
            "This StackSet appears to be SERVICE_MANAGED (Control Tower or AWS-managed). Only SELF_MANAGED StackSets are supported for blueprint registration.",
          errorType: "UNSUPPORTED_PERMISSION_MODEL",
        };
      }
    }

    return { isValid: true, stackSet };
  }

  private validateStackSetStatus(stackSet: StackSet): ValidationResult {
    if (stackSet.Status !== StackSetStatus.ACTIVE) {
      return {
        isValid: false,
        errorMessage: "StackSet must be in ACTIVE status for registration.",
        errorType: "INVALID_STATUS",
      };
    }
    return { isValid: true, stackSet };
  }

  private validateRoleConfiguration(stackSet: StackSet): ValidationResult {
    const isUsingRecommendedAdminRole =
      stackSet.AdministrationRoleARN === this.env.INTERMEDIATE_ROLE_ARN;
    const isUsingRecommendedExecutionRole =
      stackSet.ExecutionRoleName === this.env.SANDBOX_ACCOUNT_ROLE_NAME;

    if (!isUsingRecommendedAdminRole || !isUsingRecommendedExecutionRole) {
      logger.warn(
        `StackSet ID '${stackSet.StackSetId}' is not using recommended ISB roles. Deployment may fail if custom roles do not have required permissions to deploy StackSet instances`,
        {
          stackSetId: stackSet.StackSetId,
          currentAdministrationRoleARN: stackSet.AdministrationRoleARN,
          expectedAdministrationRoleARN: this.env.INTERMEDIATE_ROLE_ARN,
          isUsingRecommendedAdminRole,
          currentExecutionRoleName: stackSet.ExecutionRoleName,
          expectedExecutionRoleName: this.env.SANDBOX_ACCOUNT_ROLE_NAME,
          isUsingRecommendedExecutionRole,
        },
      );
    }
    return { isValid: true, stackSet };
  }

  async validateStackSet(stackSetId: string): Promise<ValidationResult> {
    try {
      const stackSet = await this.getStackSet(stackSetId);

      const permissionCheck = this.validatePermissionModel(stackSet);
      if (!permissionCheck.isValid) return permissionCheck;

      const statusCheck = this.validateStackSetStatus(stackSet);
      if (!statusCheck.isValid) return statusCheck;

      const roleCheck = this.validateRoleConfiguration(stackSet);
      if (!roleCheck.isValid) return roleCheck;

      logger.info(
        `StackSet ID '${stackSetId}' validated successfully with SELF_MANAGED permission model and ACTIVE status`,
        {
          permissionModel: stackSet.PermissionModel,
          status: stackSet.Status,
          stackSetId: stackSet.StackSetId,
        },
      );

      return { isValid: true, stackSet };
    } catch (error) {
      if (error instanceof StackSetNotFoundError) {
        return {
          isValid: false,
          errorMessage: error.message,
          errorType: "NOT_FOUND",
        };
      }
      throw error;
    }
  }

  async validateStackSetForDeployment(
    storedStackSetId: string,
  ): Promise<StackSet> {
    const stackSet = await this.getStackSet(storedStackSetId);

    const permissionCheck = this.validatePermissionModel(stackSet);
    if (!permissionCheck.isValid) {
      if (permissionCheck.errorType === "UNSUPPORTED_PERMISSION_MODEL") {
        throw new UnsupportedPermissionModelError(
          permissionCheck.errorMessage!,
        );
      }
      throw new Error(permissionCheck.errorMessage);
    }

    const statusCheck = this.validateStackSetStatus(stackSet);
    if (!statusCheck.isValid) {
      throw new Error(statusCheck.errorMessage);
    }

    this.validateRoleConfiguration(stackSet);

    logger.info(
      `StackSet ID '${storedStackSetId}' validated successfully for deployment`,
      {
        permissionModel: stackSet.PermissionModel,
        status: stackSet.Status,
        stackSetId: stackSet.StackSetId,
      },
    );

    return stackSet;
  }

  /**
   * Ensures StackSet exists and is properly configured to prevent deployment failures.
   *
   * @throws StackSetNotFoundError if StackSet doesn't exist (may have been deleted/recreated)
   */
  async validateBlueprintForDeployment(
    blueprintId: string,
    blueprintStore: BlueprintStore,
  ): Promise<BlueprintWithStackSets> {
    const blueprintResult = await blueprintStore.get(blueprintId);

    if (!blueprintResult.result) {
      logger.error("Blueprint validation failed", {
        blueprintId,
        validationError: blueprintResult.error,
      });
      throw new Error(
        blueprintResult.error ?? "Blueprint not found. Cannot approve lease.",
      );
    }

    const blueprintWithStackSets = blueprintResult.result;
    const blueprint = blueprintWithStackSets.blueprint;
    const stackSet = blueprintWithStackSets.stackSets[0];

    if (!stackSet) {
      throw new Error("Blueprint has no StackSets configured.");
    }

    await this.validateStackSetForDeployment(stackSet.stackSetId);

    logger.info(`Blueprint validation passed for ${blueprint.name}`, {
      blueprintId: blueprint.blueprintId,
      blueprintName: blueprint.name,
      stackSetId: stackSet.stackSetId,
    });

    return blueprintWithStackSets;
  }

  /**
   * Only removes metadata (RetainStacks=true) - AWS Nuke handles actual resource cleanup.
   * Fire-and-forget operation that logs errors but doesn't throw.
   */
  async deleteStackInstancesMetadata(
    blueprintId: string,
    accountId: string,
    blueprintStore: BlueprintStore,
  ): Promise<void> {
    try {
      const blueprintResult = await blueprintStore.get(blueprintId);

      if (!blueprintResult.result) {
        logger.warn(
          `Blueprint ${blueprintId} not found. Skipping stack instance metadata cleanup.`,
          { blueprintId, accountId },
        );
        return;
      }

      const blueprintWithStackSets = blueprintResult.result;
      const blueprint = blueprintWithStackSets.blueprint;
      const stackSets = blueprintWithStackSets.stackSets;

      if (!stackSets?.length) {
        logger.warn(
          `Blueprint ${blueprint.name} has no StackSets configured. Skipping stack instance metadata cleanup.`,
          {
            ...searchableBlueprintProperties(blueprintWithStackSets),
            accountId,
          },
        );
        return;
      }

      const stackSetConfig = stackSets[0]!;

      logger.info(
        `Removing stack instance metadata for blueprint ${blueprint.name} from account ${accountId}`,
        {
          ...searchableBlueprintProperties(blueprintWithStackSets),
          accountId,
        },
      );

      await this.cloudFormationClient.send(
        new DeleteStackInstancesCommand({
          StackSetName: stackSetConfig.stackSetId, // Use ID (AWS API accepts either name or ID)
          Accounts: [accountId],
          Regions: stackSetConfig.regions,
          RetainStacks: true,
          OperationPreferences: {
            MaxConcurrentCount: 1,
            FailureToleranceCount: 0,
          },
        }),
      );

      logger.info(
        `Stack instance metadata removal initiated for blueprint ${blueprint.name}`,
        {
          ...searchableBlueprintProperties(blueprintWithStackSets),
          accountId,
        },
      );
    } catch (error) {
      logger.error(
        `Failed to remove stack instance metadata. Continuing with lease termination.`,
        {
          error: error instanceof Error ? error.message : String(error),
          blueprintId,
          accountId,
        },
      );
    }
  }

  /**
   * Lists active StackSets with optional pagination.
   * In the Org Management Account, filters out AWSControlTower-prefixed StackSets
   * since they are AWS-managed and not suitable for blueprints.
   */
  async listStackSets(options?: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<{
    stackSets: StackSet[];
    nextPageIdentifier?: string;
  }> {
    const command = new ListStackSetsCommand({
      Status: StackSetStatus.ACTIVE,
      NextToken: options?.pageIdentifier,
      MaxResults: options?.pageSize,
    });

    const response = await this.cloudFormationClient.send(command);

    // Determine if we're in the Org Management Account
    const isOrgManagementAccount =
      this.env.ORG_MGT_ACCOUNT_ID === this.env.HUB_ACCOUNT_ID;

    // Filter StackSets
    let stackSets = response.Summaries ?? [];

    // Only filter out AWSControlTower StackSets when in Org Management Account
    // Rationale: Control Tower StackSets are AWS-managed and should not be used
    // for blueprints. However, users in member accounts might legitimately create
    // StackSets with "AWSControlTower" prefix, so we only filter in org mgmt account.
    if (isOrgManagementAccount) {
      stackSets = stackSets.filter(
        (stackSet) => !stackSet.StackSetName?.startsWith("AWSControlTower"),
      );
    }

    return {
      stackSets,
      nextPageIdentifier: response.NextToken,
    };
  }

  /**
   * Validates that a blueprint is not in use by any lease templates
   * @param blueprintId - The blueprint ID to validate
   * @param leaseTemplateStore - Store to query lease templates
   * @throws BlueprintInUseError if the blueprint is in use
   */
  async validateBlueprintNotInUse(
    blueprintId: string,
    leaseTemplateStore: LeaseTemplateStore,
  ): Promise<void> {
    logger.info("Validating blueprint is not in use", { blueprintId });

    const leaseTemplatesUsingBlueprint =
      await leaseTemplateStore.findByBlueprintId(blueprintId);

    if (leaseTemplatesUsingBlueprint.length > 0) {
      const templateUuids = leaseTemplatesUsingBlueprint
        .map((template) => template.uuid)
        .join(", ");

      logger.warn(
        `Blueprint is in use by ${leaseTemplatesUsingBlueprint.length} lease template(s)`,
        {
          blueprintId,
          templateCount: leaseTemplatesUsingBlueprint.length,
          templateUuids,
        },
      );

      throw new BlueprintInUseError(
        "Blueprint is currently in use by one or more lease templates and cannot be deleted.",
      );
    }
  }
}
