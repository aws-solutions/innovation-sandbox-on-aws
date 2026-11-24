// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, Duration, RemovalPolicy, Token } from "aws-cdk-lib";
import { Policy, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import {
  ApplicationLogLevel,
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

import { BaseLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment";
import { getAppConfigExtensionConfig } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { LambdaLayers } from "@amzn/innovation-sandbox-infrastructure/components/lambda-layers";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";
import { getCustomUserAgent } from "@amzn/innovation-sandbox-infrastructure/helpers/manifest-reader";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";

/**
 * Modules esbuild must NOT inline for a Lambda served by the generated Smithy server SDK.
 *
 * `re2-wasm` ships a JavaScript wrapper plus a separate `re2.wasm` binary, and the
 * Smithy server SDK's validation module imports it eagerly for regex validation. If
 * esbuild bundles the JavaScript, `re2-wasm` tries to locate `re2.wasm` relative to
 * `/var/task` (the inlined `__dirname`), where the binary was never copied, so the
 * Lambda fails during cold start before handling any request. It must therefore be:
 *   1. listed in `externalModules` so esbuild does not inline it; and
 *   2. an explicit dependency of the Lambda dependencies layer (see
 *      `source/layers/dependencies/package.json`) so its original directory
 *      structure and `.wasm` file stay intact and resolvable via `NODE_PATH` at
 *      runtime.
 *
 * `@aws-sdk/*` is restated because setting `externalModules` replaces CDK's default
 * (`["@aws-sdk/*"]`) rather than extending it — otherwise esbuild would bundle the AWS
 * SDK v3 the Lambda runtime already provides, bloating the artifact and shadowing it.
 */
const smithyServerExternalModules = ["@aws-sdk/*", "re2-wasm"];

export interface IsbLambdaFunctionProps<
  T extends z.ZodType<Record<string, string>>,
> extends Omit<NodejsFunctionProps, "role" | "runtime"> {
  kmsKey?: Key;
  layers?: ILayerVersion[];
  logGroup?: LogGroup;
  namespace: string;
  envSchema: T;
  environment: Omit<z.infer<T>, keyof BaseLambdaEnvironment | "AWS_REGION"> & {
    POWERTOOLS_SERVICE_NAME?: string;
  };
}

export class IsbLambdaFunction<
  T extends z.ZodType<Record<string, string>>,
> extends Construct {
  readonly lambdaFunction: NodejsFunction;
  readonly kmsKey: Key;
  constructor(scope: Construct, id: string, props: IsbLambdaFunctionProps<T>) {
    super(scope, id);

    const functionRole = new Role(this, "FunctionRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com", {
        region: Aws.REGION,
      }),
    });

    const baseEnvironment: BaseLambdaEnvironment = {
      NODE_OPTIONS: "--enable-source-maps",
      USER_AGENT_EXTRA: getCustomUserAgent(),
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
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      tracing: Tracing.ACTIVE,
      timeout: Duration.minutes(1),
      memorySize: 1024,
      loggingFormat: LoggingFormat.JSON,
      applicationLogLevelV2: isDevMode(scope)
        ? ApplicationLogLevel.DEBUG
        : ApplicationLogLevel.INFO,
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

    if (props.logGroup === undefined) {
      //if no log group provided, explicitly manage the default lambda log group instead
      const functionLogGroup = new LogGroup(this, "FunctionLogGroup", {
        logGroupName: `/aws/lambda/${this.lambdaFunction.functionName}`,
        encryptionKey: this.kmsKey,
        removalPolicy: isDevMode(scope)
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN,
        retention: Token.asNumber(
          getContextFromMapping(scope, "cloudWatchLogRetentionInDays"),
        ),
      });
      addCfnGuardSuppression(functionLogGroup, [
        "CW_LOGGROUP_RETENTION_PERIOD_CHECK",
      ]); // Retention period is defined in CfnMapping and evades the CFN Guard check
      const functionPolicy = new Policy(this, "FunctionPolicy", {
        roles: [functionRole],
      });

      functionLogGroup.grantWrite(functionPolicy);
    } else {
      props.logGroup.grantWrite(this.lambdaFunction);
    }

    addCfnGuardSuppression(this.lambdaFunction, ["LAMBDA_INSIDE_VPC"]);
    addCfnGuardSuppression(this.lambdaFunction, ["LAMBDA_CONCURRENCY_CHECK"]);
  }
}

/**
 * An {@link IsbLambdaFunction} for an API-Gateway-integrated Lambda served by the
 * generated Smithy server SDK. It externalizes `smithyServerExternalModules`
 * (`@aws-sdk/*` + `re2-wasm` — see that const's doc) so each `components/api/*-api.ts`
 * need not repeat it; the shared list lives here, in one place. Non-API lambdas use
 * `IsbLambdaFunction` directly. A caller-supplied `bundling` still merges on top — its
 * own keys win, but `externalModules` is unioned so a caller override can never drop
 * the required externalization.
 *
 * API lambdas also share the global log group by default, so each `*-api.ts` need not
 * pass `logGroup`; a caller-supplied `logGroup` still wins.
 */
export class IsbApiLambdaFunction<
  T extends z.ZodType<Record<string, string>>,
> extends IsbLambdaFunction<T> {
  constructor(scope: Construct, id: string, props: IsbLambdaFunctionProps<T>) {
    super(scope, id, {
      ...props,
      logGroup: props.logGroup ?? IsbComputeResources.globalLogGroup,
      bundling: {
        ...props.bundling,
        externalModules: [
          ...new Set([
            ...smithyServerExternalModules,
            ...(props.bundling?.externalModules ?? []),
          ]),
        ],
      },
    });
  }
}
