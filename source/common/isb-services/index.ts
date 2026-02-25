// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  AccountPoolStackConfigStore,
  SsmAccountPoolStackConfigStore,
} from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js";
import { BlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import {
  DataStackConfigStore,
  SsmDataStackConfigStore,
} from "@amzn/innovation-sandbox-commons/data/data-stack-config/ssm-data-stack-config-store.js";
import {
  IdcStackConfigStore,
  SsmIdcStackConfigStore,
} from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import { BlueprintDeploymentService } from "@amzn/innovation-sandbox-commons/isb-services/blueprint-deployment-service.js";
import { CostExplorerService } from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import {
  LogArchivingService,
  LogArchivingServiceProps,
} from "@amzn/innovation-sandbox-commons/isb-services/log-archiving-service.js";
import {
  EmailService,
  EmailServiceProps,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/email-service.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  AwsCredentialIdentity,
  AwsCredentialIdentityProvider,
} from "@aws-sdk/types";

export namespace ServiceEnv {
  export type leaseStore = {
    LEASE_TABLE_NAME: string;
    USER_AGENT_EXTRA: string;
  };

  export type sandboxAccountStore = {
    ACCOUNT_TABLE_NAME: string;
    USER_AGENT_EXTRA: string;
  };

  export type leaseTemplateStore = {
    LEASE_TEMPLATE_TABLE_NAME: string;
    USER_AGENT_EXTRA: string;
  };

  export type blueprintStore = {
    BLUEPRINT_TABLE_NAME: string;
    USER_AGENT_EXTRA: string;
  };

  export type accountPoolStackConfigStore = {
    ACCOUNT_POOL_CONFIG_PARAM_ARN: string;
    USER_AGENT_EXTRA: string;
  };

  export type dataStackConfigStore = {
    DATA_CONFIG_PARAM_ARN: string;
    USER_AGENT_EXTRA: string;
  };

  export type idcStackConfigStore = {
    IDC_CONFIG_PARAM_ARN: string;
    USER_AGENT_EXTRA: string;
  };

  export type isbEventBridge = {
    USER_AGENT_EXTRA: string;
    ISB_EVENT_BUS: string;
    ISB_NAMESPACE: string;
  };

  export type idcService = {
    IDC_CONFIG_PARAM_ARN: string;
    USER_AGENT_EXTRA: string;
  };

  export type orgsService = {
    ACCOUNT_POOL_CONFIG_PARAM_ARN: string;
    ACCOUNT_TABLE_NAME: string;
    USER_AGENT_EXTRA: string;
  };

  export type costExplorer = {
    USER_AGENT_EXTRA: string;
  };

  export type emailService = {
    ISB_NAMESPACE: string;
    IDC_ROLE_ARN: string;
    INTERMEDIATE_ROLE_ARN: string;
    USER_AGENT_EXTRA: string;
  } & idcService;

  export type logArchivingService = {
    USER_AGENT_EXTRA: string;
  };

  export type blueprintDeploymentService = {
    INTERMEDIATE_ROLE_ARN: string;
    SANDBOX_ACCOUNT_ROLE_NAME: string;
    ORG_MGT_ACCOUNT_ID: string;
    HUB_ACCOUNT_ID: string;
    USER_AGENT_EXTRA: string;
  };
}

/**
 * typed factories that extract relevant pieces of an environment json to build each service
 */
export class IsbServices {
  private constructor() {
    //static class. Shouldn't be constructable
  }

  public static leaseStore(env: ServiceEnv.leaseStore): LeaseStore {
    return new DynamoLeaseStore({
      client: IsbClients.dynamo(env),
      leaseTableName: env.LEASE_TABLE_NAME,
    });
  }

  public static sandboxAccountStore(
    env: ServiceEnv.sandboxAccountStore,
  ): SandboxAccountStore {
    return new DynamoSandboxAccountStore({
      client: IsbClients.dynamo(env),
      accountTableName: env.ACCOUNT_TABLE_NAME,
    });
  }

  public static leaseTemplateStore(
    env: ServiceEnv.leaseTemplateStore,
  ): LeaseTemplateStore {
    return new DynamoLeaseTemplateStore({
      client: IsbClients.dynamo(env),
      leaseTemplateTableName: env.LEASE_TEMPLATE_TABLE_NAME,
    });
  }

  public static blueprintStore(env: ServiceEnv.blueprintStore): BlueprintStore {
    return new DynamoBlueprintStore({
      client: IsbClients.dynamo(env),
      blueprintTableName: env.BLUEPRINT_TABLE_NAME,
    });
  }

  public static accountPoolStackConfigStore(
    env: ServiceEnv.accountPoolStackConfigStore,
  ): AccountPoolStackConfigStore {
    return new SsmAccountPoolStackConfigStore({
      parameterArn: env.ACCOUNT_POOL_CONFIG_PARAM_ARN,
      ssmProvider: IsbClients.ssmProvider(env),
    });
  }

  public static dataStackConfigStore(
    env: ServiceEnv.dataStackConfigStore,
  ): DataStackConfigStore {
    return new SsmDataStackConfigStore({
      parameterArn: env.DATA_CONFIG_PARAM_ARN,
      ssmProvider: IsbClients.ssmProvider(env),
    });
  }

  public static idcStackConfigStore(
    env: ServiceEnv.idcStackConfigStore,
  ): IdcStackConfigStore {
    return new SsmIdcStackConfigStore({
      parameterArn: env.IDC_CONFIG_PARAM_ARN,
      ssmProvider: IsbClients.ssmProvider(env),
    });
  }

  public static isbEventBridge(
    env: ServiceEnv.isbEventBridge,
  ): IsbEventBridgeClient {
    return IsbClients.eventBridge(
      {
        eventSource: `InnovationSandbox-${env.ISB_NAMESPACE}`,
      },
      env,
    );
  }

  public static idcService(
    env: ServiceEnv.idcService,
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ) {
    return new IdcService({
      idcStackConfigStore: IsbServices.idcStackConfigStore(env),
      ssoAdminClient: IsbClients.ssoAdmin(env, credentials),
      identityStoreClient: IsbClients.identityStore(env, credentials),
    });
  }

  public static orgsService(
    env: ServiceEnv.orgsService,
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ) {
    return new SandboxOuService({
      sandboxAccountStore: IsbServices.sandboxAccountStore(env),
      orgsClient: IsbClients.orgs(env, credentials),
      accountPoolStackConfigStore: IsbServices.accountPoolStackConfigStore(env),
    });
  }

  public static costExplorer(
    env: ServiceEnv.costExplorer,
    credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider,
  ) {
    return new CostExplorerService({
      costExplorerClient: IsbClients.costExplorer(env, credentials),
    });
  }

  public static emailService(
    env: ServiceEnv.emailService,
    props: EmailServiceProps,
  ) {
    return new EmailService(env, props);
  }

  public static logArchivingService(
    env: ServiceEnv.logArchivingService,
    props: LogArchivingServiceProps,
  ) {
    return new LogArchivingService(env, props);
  }

  public static blueprintDeploymentService(
    env: ServiceEnv.blueprintDeploymentService,
  ): BlueprintDeploymentService {
    return new BlueprintDeploymentService(IsbClients.cloudFormation(env), {
      INTERMEDIATE_ROLE_ARN: env.INTERMEDIATE_ROLE_ARN,
      SANDBOX_ACCOUNT_ROLE_NAME: env.SANDBOX_ACCOUNT_ROLE_NAME,
      ORG_MGT_ACCOUNT_ID: env.ORG_MGT_ACCOUNT_ID,
      HUB_ACCOUNT_ID: env.HUB_ACCOUNT_ID,
    });
  }
}
