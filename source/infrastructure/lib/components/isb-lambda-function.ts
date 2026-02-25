// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Policy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import {
  Architecture,
  ILayerVersion,
  LoggingFormat,
  Runtime,
  SystemLogLevel,
  Tracing,
} from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  type NodejsFunctionProps,
} from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { z } from "zod";

import {
  BaseLambdaEnvironment,
  LogLevelSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment";
import { getAppConfigExtensionConfig } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { LambdaLayers } from "@amzn/innovation-sandbox-infrastructure/components/lambda-layers";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";
import { getCustomUserAgent } from "@amzn/innovation-sandbox-infrastructure/helpers/manifest-reader";

export interface IsbLambdaFunctionProps<
  T extends z.ZodSchema<any>,
> extends Omit<NodejsFunctionProps, "role" | "runtime"> {
  kmsKey?: Key;
  layers?: ILayerVersion[];
  logGroup?: LogGroup;
  namespace: string;
  envSchema: T;
  environment: Omit<z.infer<T>, keyof BaseLambdaEnvironment> & {
    POWERTOOLS_SERVICE_NAME?: string;
  };
}

export class IsbLambdaFunction<T extends z.ZodSchema<any>> extends Construct {
  readonly lambdaFunction: NodejsFunction;
  readonly kmsKey: Key;
  constructor(scope: Construct, id: string, props: IsbLambdaFunctionProps<T>) {
    super(scope, id);

    const functionRole = new Role(this, "FunctionRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com", {
        region: Aws.REGION,
      }),
    });

    // prettier-ignore
    const baseEnvironment: BaseLambdaEnvironment = {
      NODE_OPTIONS: "--enable-source-maps",
      USER_AGENT_EXTRA: getCustomUserAgent(),
      POWERTOOLS_LOG_LEVEL: isDevMode(scope)
        ? "DEBUG"
        : (getContextFromMapping(scope, "logLevel") as z.infer< // NOSONAR typescript:S4325 - type assertion is necessary for TypeScript type checking
            typeof LogLevelSchema
          >),
      POWERTOOLS_SERVICE_NAME: "innovation-sandbox",
      AWS_XRAY_CONTEXT_MISSING: "IGNORE_ERROR",
    };

    const extraAppConfigExtensionProps = props.environment
      .AWS_APPCONFIG_EXTENSION_PREFETCH_LIST
      ? getAppConfigExtensionConfig()
      : {};

    const environment = {
      ...baseEnvironment,
      ...props.environment,
      ...extraAppConfigExtensionProps,
    };

    this.lambdaFunction = new NodejsFunction(this, "Function", {
      functionName: `ISB-${id}-${props.namespace}`,
      role: functionRole,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      tracing: Tracing.ACTIVE,
      timeout: Duration.minutes(1),
      memorySize: 1024,
      loggingFormat: LoggingFormat.JSON,
      systemLogLevelV2: SystemLogLevel.INFO,
      ...props,
      bundling: {
        sourceMap: true,
        ...props.bundling,
      },
      layers: props.layers ?? LambdaLayers.get(scope).layers,
      environment,
    });

    this.kmsKey = props.kmsKey ?? IsbKmsKeys.get(scope, props.namespace);
    this.kmsKey.grantEncryptDecrypt(
      new ServicePrincipal("logs.amazonaws.com", { region: Aws.REGION }),
    );

    if (props.logGroup !== undefined) {
      props.logGroup.grantWrite(this.lambdaFunction);
    } else {
      //if no log group provided, explicitly manage the default lambda log group instead
      const functionLogGroup = new LogGroup(this, "FunctionLogGroup", {
        logGroupName: `/aws/lambda/${this.lambdaFunction.functionName}`,
        encryptionKey: this.kmsKey,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const functionPolicy = new Policy(this, "FunctionPolicy", {
        roles: [functionRole],
      });

      functionLogGroup.grantWrite(functionPolicy);
    }

    addCfnGuardSuppression(this.lambdaFunction, ["LAMBDA_INSIDE_VPC"]);
    addCfnGuardSuppression(this.lambdaFunction, ["LAMBDA_CONCURRENCY_CHECK"]);
  }
}
