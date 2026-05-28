// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { CfnMapping, Stack } from "aws-cdk-lib";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { z } from "zod";

const mappingInstances: { [key: string]: CfnMapping } = {};

// values from https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions-versions.html
// Version 2.0.17054.0 (ARM64 platform)
const layerArns: { [key: string]: string } = {
  "us-east-1":
    "arn:aws:lambda:us-east-1:027255383542:layer:AWS-AppConfig-Extension-Arm64:254",
  "us-east-2":
    "arn:aws:lambda:us-east-2:728743619870:layer:AWS-AppConfig-Extension-Arm64:229",
  "us-west-1":
    "arn:aws:lambda:us-west-1:958113053741:layer:AWS-AppConfig-Extension-Arm64:272",
  "us-west-2":
    "arn:aws:lambda:us-west-2:359756378197:layer:AWS-AppConfig-Extension-Arm64:275",
  "ca-central-1":
    "arn:aws:lambda:ca-central-1:039592058896:layer:AWS-AppConfig-Extension-Arm64:182",
  "ca-west-1":
    "arn:aws:lambda:ca-west-1:436199621743:layer:AWS-AppConfig-Extension-Arm64:162",
  "eu-central-1":
    "arn:aws:lambda:eu-central-1:066940009817:layer:AWS-AppConfig-Extension-Arm64:238",
  "eu-central-2":
    "arn:aws:lambda:eu-central-2:758369105281:layer:AWS-AppConfig-Extension-Arm64:178",
  "eu-west-1":
    "arn:aws:lambda:eu-west-1:434848589818:layer:AWS-AppConfig-Extension-Arm64:241",
  "eu-west-2":
    "arn:aws:lambda:eu-west-2:282860088358:layer:AWS-AppConfig-Extension-Arm64:194",
  "eu-west-3":
    "arn:aws:lambda:eu-west-3:493207061005:layer:AWS-AppConfig-Extension-Arm64:192",
  "eu-north-1":
    "arn:aws:lambda:eu-north-1:646970417810:layer:AWS-AppConfig-Extension-Arm64:226",
  "eu-south-1":
    "arn:aws:lambda:eu-south-1:203683718741:layer:AWS-AppConfig-Extension-Arm64:177",
  "eu-south-2":
    "arn:aws:lambda:eu-south-2:586093569114:layer:AWS-AppConfig-Extension-Arm64:175",
  "ap-east-1":
    "arn:aws:lambda:ap-east-1:630222743974:layer:AWS-AppConfig-Extension-Arm64:182",
  "ap-east-2":
    "arn:aws:lambda:ap-east-2:730335625313:layer:AWS-AppConfig-Extension-Arm64:121",
  "ap-northeast-1":
    "arn:aws:lambda:ap-northeast-1:980059726660:layer:AWS-AppConfig-Extension-Arm64:225",
  "ap-northeast-2":
    "arn:aws:lambda:ap-northeast-2:826293736237:layer:AWS-AppConfig-Extension-Arm64:181",
  "ap-northeast-3":
    "arn:aws:lambda:ap-northeast-3:706869817123:layer:AWS-AppConfig-Extension-Arm64:187",
  "ap-southeast-1":
    "arn:aws:lambda:ap-southeast-1:421114256042:layer:AWS-AppConfig-Extension-Arm64:210",
  "ap-southeast-2":
    "arn:aws:lambda:ap-southeast-2:080788657173:layer:AWS-AppConfig-Extension-Arm64:256",
  "ap-southeast-3":
    "arn:aws:lambda:ap-southeast-3:418787028745:layer:AWS-AppConfig-Extension-Arm64:193",
  "ap-southeast-4":
    "arn:aws:lambda:ap-southeast-4:307021474294:layer:AWS-AppConfig-Extension-Arm64:173",
  "ap-southeast-5":
    "arn:aws:lambda:ap-southeast-5:631746059939:layer:AWS-AppConfig-Extension-Arm64:136",
  "ap-southeast-6":
    "arn:aws:lambda:ap-southeast-6:381491832265:layer:AWS-AppConfig-Extension-Arm64:87",
  "ap-southeast-7":
    "arn:aws:lambda:ap-southeast-7:851725616657:layer:AWS-AppConfig-Extension-Arm64:133",
  "ap-south-1":
    "arn:aws:lambda:ap-south-1:554480029851:layer:AWS-AppConfig-Extension-Arm64:232",
  "ap-south-2":
    "arn:aws:lambda:ap-south-2:489524808438:layer:AWS-AppConfig-Extension-Arm64:175",
  "sa-east-1":
    "arn:aws:lambda:sa-east-1:000010852771:layer:AWS-AppConfig-Extension-Arm64:215",
  "mx-central-1":
    "arn:aws:lambda:mx-central-1:891376990304:layer:AWS-AppConfig-Extension-Arm64:141",
  "af-south-1":
    "arn:aws:lambda:af-south-1:574348263942:layer:AWS-AppConfig-Extension-Arm64:188",
  "me-central-1":
    "arn:aws:lambda:me-central-1:662846165436:layer:AWS-AppConfig-Extension-Arm64:168",
  "me-south-1":
    "arn:aws:lambda:me-south-1:559955524753:layer:AWS-AppConfig-Extension-Arm64:182",
  "il-central-1":
    "arn:aws:lambda:il-central-1:895787185223:layer:AWS-AppConfig-Extension-Arm64:171",
  "cn-north-1":
    "arn:aws-cn:lambda:cn-north-1:615057806174:layer:AWS-AppConfig-Extension-Arm64:165",
  "cn-northwest-1":
    "arn:aws-cn:lambda:cn-northwest-1:615084187847:layer:AWS-AppConfig-Extension-Arm64:163",
  "us-gov-east-1":
    "arn:aws-us-gov:lambda:us-gov-east-1:946561847325:layer:AWS-AppConfig-Extension-Arm64:165",
  "us-gov-west-1":
    "arn:aws-us-gov:lambda:us-gov-west-1:946746059096:layer:AWS-AppConfig-Extension-Arm64:166",
};

export function addAppConfigExtensionLayer<T extends z.ZodSchema<any>>(
  isbLambdaFunction: IsbLambdaFunction<T>,
) {
  const appConfigExtensionLayer = LayerVersion.fromLayerVersionArn(
    isbLambdaFunction,
    "AppConfigExtensionLayer",
    getLatestLayerARN(isbLambdaFunction),
  );
  isbLambdaFunction.lambdaFunction.addLayers(appConfigExtensionLayer);
}

function getLatestLayerARN(scope: Construct) {
  const stack = Stack.of(scope);
  const mapping = getOrCreateMapping(scope);
  return mapping.findInMap(stack.region, "arn");
}

function getOrCreateMapping(scope: Construct) {
  const stack = Stack.of(scope);
  const stackName = stack.stackName;
  if (!mappingInstances[stackName]) {
    mappingInstances[stackName] = new CfnMapping(
      stack,
      "AppConfigExtensionArnMap",
      {
        mapping: Object.entries(layerArns).reduce(
          (acc, [region, arn]) => {
            acc[region] = { arn };
            return acc;
          },
          {} as Record<string, { arn: string }>,
        ),
      },
    );
  }
  return mappingInstances[stackName];
}

/**
 * retrieves the default config for the app config extension
 *  ref https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions-config.html
 */
export function getAppConfigExtensionConfig() {
  return {
    AWS_APPCONFIG_EXTENSION_POLL_INTERVAL_SECONDS: "10m",
    AWS_APPCONFIG_EXTENSION_HTTP_PORT: "2772",
  };
}
