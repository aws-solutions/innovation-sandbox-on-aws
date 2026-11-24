// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CreateHostedConfigurationVersionCommand,
  GetDeploymentCommand,
  StartDeploymentCommand,
} from "@aws-sdk/client-appconfig";
import {
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import { Uint8ArrayBlobAdapter } from "@smithy/util-stream";

import { GlobalConfigStore } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-store.js";
import {
  AppConfigGlobalConfig,
  GlobalConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import yaml from "js-yaml";

interface AppConfigGlobalConfigStoreProps {
  applicationId: string;
  globalConfigConfigurationProfileId: string;
  environmentId: string;
  deploymentStrategyId: string;
  lambdaEnv: {
    USER_AGENT_EXTRA: string;
  };
}

export class AppConfigGlobalConfigStore extends GlobalConfigStore {
  private readonly applicationId: string;
  private readonly globalConfigConfigurationProfileId: string;
  private readonly environmentId: string;
  private readonly deploymentStrategyId: string;
  private readonly lambdaEnv: {
    USER_AGENT_EXTRA: string;
  };
  private configurationToken?: string;
  constructor(props: AppConfigGlobalConfigStoreProps) {
    super();
    this.applicationId = props.applicationId;
    this.globalConfigConfigurationProfileId =
      props.globalConfigConfigurationProfileId;
    this.environmentId = props.environmentId;
    this.deploymentStrategyId = props.deploymentStrategyId;
    this.lambdaEnv = props.lambdaEnv;
  }

  public async put(
    globalConfig: AppConfigGlobalConfig,
  ): Promise<AppConfigGlobalConfig> {
    const createHostedConfigurationVersionResponse = await IsbClients.appConfig(
      this.lambdaEnv,
    ).send(
      new CreateHostedConfigurationVersionCommand({
        ApplicationId: this.applicationId,
        ConfigurationProfileId: this.globalConfigConfigurationProfileId,
        ContentType: "application/yaml",
        Content: Uint8ArrayBlobAdapter.fromString(yaml.dump(globalConfig)),
      }),
    );

    const startDeploymentResponse = await IsbClients.appConfig(
      this.lambdaEnv,
    ).send(
      new StartDeploymentCommand({
        ApplicationId: this.applicationId,
        ConfigurationProfileId: this.globalConfigConfigurationProfileId,
        EnvironmentId: this.environmentId,
        DeploymentStrategyId: this.deploymentStrategyId,
        ConfigurationVersion:
          createHostedConfigurationVersionResponse.VersionNumber?.toString(),
      }),
    );

    await IsbClients.appConfig(this.lambdaEnv).send(
      new GetDeploymentCommand({
        ApplicationId: this.applicationId,
        DeploymentNumber: startDeploymentResponse.DeploymentNumber,
        EnvironmentId: this.environmentId,
      }),
    );

    try {
      const content = createHostedConfigurationVersionResponse.Content;
      if (content === undefined) {
        throw new Error(
          "Hosted configuration version response did not include content.",
        );
      }

      return GlobalConfigSchema.parse(
        yaml.load(Buffer.from(content).toString("utf8"), {
          schema: yaml.JSON_SCHEMA,
        }),
      );
    } catch (error) {
      throw new Error(`Could not parse configuration: ${error}`);
    }
  }

  public async get(): Promise<AppConfigGlobalConfig> {
    if (!this.configurationToken) {
      const startSessionResponse = await IsbClients.appConfigData(
        this.lambdaEnv,
      ).send(
        new StartConfigurationSessionCommand({
          ApplicationIdentifier: this.applicationId,
          ConfigurationProfileIdentifier:
            this.globalConfigConfigurationProfileId,
          EnvironmentIdentifier: this.environmentId,
        }),
      );
      this.configurationToken = startSessionResponse.InitialConfigurationToken;
    }

    const getLatestConfigurationResponse = await IsbClients.appConfigData(
      this.lambdaEnv,
    ).send(
      new GetLatestConfigurationCommand({
        ConfigurationToken: this.configurationToken,
      }),
    );

    this.configurationToken =
      getLatestConfigurationResponse.NextPollConfigurationToken;

    if (!getLatestConfigurationResponse.Configuration) {
      throw new Error("No configuration found.");
    }

    try {
      return GlobalConfigSchema.parse(
        yaml.load(
          Buffer.from(getLatestConfigurationResponse.Configuration).toString(
            "utf8",
          ),
          { schema: yaml.JSON_SCHEMA },
        ),
      );
    } catch (error) {
      throw new Error(`Could not parse configuration: ${error}`);
    }
  }
}
