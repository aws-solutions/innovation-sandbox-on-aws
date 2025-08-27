// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CfnOutput,
  CfnResource,
  Duration,
  RemovalPolicy,
  Stack,
  Token,
} from "aws-cdk-lib";
import { RestApi as ApiGatewayRestApi } from "aws-cdk-lib/aws-apigateway";
import {
  AllowedMethods,
  CachePolicy,
  Function as CloudFrontFunction,
  FunctionCode as CloudFrontFunctionCode,
  Distribution,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  S3OriginAccessControl,
  SecurityPolicyProtocol,
  Signing,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import {
  RestApiOrigin,
  S3BucketOrigin,
} from "aws-cdk-lib/aws-cloudfront-origins";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectOwnership,
  StorageClass,
} from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import path from "path";

import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { IsbLogGroups } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-groups";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";

export interface CloudFrontUiApiProps {
  restApi: ApiGatewayRestApi;
  namespace: string;
}

export class CloudfrontUiApi extends Construct {
  constructor(scope: Construct, id: string, props: CloudFrontUiApiProps) {
    super(scope, id);
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);
    const feBucket = new Bucket(this, "IsbFrontEndBucket", {
      removalPolicy: isDevMode(scope)
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN,
      encryption: BucketEncryption.KMS,
      encryptionKey: kmsKey,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      publicReadAccess: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
    });

    const loggingBucket = new Bucket(this, "IsbFrontEndAccessLogsBucket", {
      removalPolicy: isDevMode(scope)
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN,
      encryption: BucketEncryption.KMS,
      encryptionKey: kmsKey,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      publicReadAccess: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false, // NOSONAR typescript:S6252 - access logs do not need versioning
      lifecycleRules: [
        {
          enabled: true,
          transitions: [
            {
              storageClass: StorageClass.GLACIER,
              transitionAfter: Duration.days(
                Token.asNumber(
                  getContextFromMapping(scope, "s3LogsArchiveRetentionInDays"),
                ),
              ),
            },
          ],
          expiration: Duration.days(
            Token.asNumber(
              getContextFromMapping(scope, "s3LogsGlacierRetentionInDays"),
            ),
          ),
        },
      ],
    });

    const oac = new S3OriginAccessControl(
      this,
      "IsbCloudFrontDistributionOac",
      {
        originAccessControlName: "IsbCloudFrontDistributionOac",
        signing: Signing.SIGV4_ALWAYS,
      },
    );

    const responseHeadersPolicy = new ResponseHeadersPolicy(
      this,
      "IsbCloudFrontResponseHeadersPolicy",
      {
        securityHeadersBehavior: {
          contentTypeOptions: {
            override: true,
          },
          frameOptions: {
            frameOption: HeadersFrameOption.DENY,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(30 * 18),
            includeSubdomains: true,
            override: true,
          },
          xssProtection: {
            protection: true,
            modeBlock: true,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: HeadersReferrerPolicy.NO_REFERRER,
            override: true,
          },
          contentSecurityPolicy: {
            contentSecurityPolicy: [
              "upgrade-insecure-requests;",
              "default-src 'none';",
              "object-src 'none';",
              "script-src 'self';",
              "style-src 'self';",
              "img-src 'self' data:;",
              "font-src 'self' data:;",
              "connect-src 'self';",
              "manifest-src 'self';",
              "frame-ancestors 'none';",
              "base-uri 'none';",
            ].join(" "),
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Cache-Control",
              value: "no-store, no-cache",
              override: true,
            },
          ],
        },
      },
    );

    const apiResponseHeadersPolicy = new ResponseHeadersPolicy(
      this,
      "IsbApiCloudFrontResponseHeadersPolicy",
      {
        securityHeadersBehavior: {
          contentTypeOptions: {
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Cache-Control",
              value: "no-store, no-cache",
              override: true,
            },
          ],
        },
      },
    );

    // the CloudFront distribution prepends /api to the requests passed to the api gateway endpoint
    // this cloudfront function strips it out
    const cfFunctionPathRewrite = new CloudFrontFunction(
      this,
      "IsbPathRewriteCloudFrontFunction",
      {
        runtime: FunctionRuntime.JS_2_0,
        functionName: "IsbPathRewriteCloudFrontFunction",
        code: CloudFrontFunctionCode.fromInline(`
          function handler (event) {
            const request = event.request;
            const uri = request.uri;
            const cfPrefix = "/api"
            if (uri.startsWith(cfPrefix)) {
              request.uri = uri.replace(cfPrefix, "");
            }
            return request;
          }
      `),
      },
    );

    // The front end uses client side routing which results in 404 errors when the page is refreshed.
    // This function simply redirects all paths that don't have an extension to index.html
    // Thus *.js and *.css files will be served as requested
    const cfFunctionS3OriginPathRedirect = new CloudFrontFunction(
      this,
      "IsbS3OriginPathRedirectCloudFrontFunction",
      {
        runtime: FunctionRuntime.JS_2_0,
        functionName: "IsbS3OriginPathRedirectCloudFrontFunction",
        code: CloudFrontFunctionCode.fromInline(`
          function handler(event) {
            const request = event.request;
            const hasType = request.uri.split(/\\#|\\?/)[0].split(".").length >= 2;
            if (hasType) return request;
            request.uri = "/index.html";
            return request;
          }
      `),
      },
    );

    const distribution = new Distribution(this, "IsbCloudFrontDistribution", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(feBucket, {
          originId: "S3Origin",
          originAccessControl: oac,
        }),
        allowedMethods: AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: responseHeadersPolicy,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: cfFunctionS3OriginPathRedirect,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new RestApiOrigin(props.restApi),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: apiResponseHeadersPolicy,
          originRequestPolicy:
            OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            {
              function: cfFunctionPathRewrite,
              eventType: FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
      defaultRootObject: "index.html",
      comment: "ISB CloudFront Distribution",
      priceClass: PriceClass.PRICE_CLASS_ALL,
      httpVersion: HttpVersion.HTTP2,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2019,
      enableIpv6: false,
      enableLogging: true,
      logBucket: loggingBucket,
      logIncludesCookies: true,
      logFilePrefix: "isb-fe-logs/",
    });

    new BucketDeployment(this, "DeployIsbFrontEnd", {
      sources: [
        Source.asset(
          path.join(__dirname, "..", "..", "..", "..", "frontend", "dist"),
        ),
      ],
      destinationBucket: feBucket,
      distribution: distribution,
      distributionPaths: ["/*"],
      logGroup: IsbLogGroups.customResourceLogGroup(scope, props.namespace),
    });

    const bucketPolicyStatement = new PolicyStatement({
      actions: ["s3:GetObject"],
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
      resources: [feBucket.arnForObjects("*")],
      conditions: {
        StringEquals: {
          "AWS:SourceArn": `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${distribution.distributionId}`,
        },
      },
    });
    feBucket.addToResourcePolicy(bucketPolicyStatement);

    kmsKey.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal("delivery.logs.amazonaws.com")],
        actions: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "AWS:SourceAccount": Stack.of(this).account,
          },
        },
      }),
    );

    new CfnOutput(this, "CloudFrontDistributionUrl", {
      key: "CloudFrontDistributionUrl",
      value: `https://${distribution.distributionDomainName}`,
    });

    addCfnGuardSuppression(feBucket, ["S3_BUCKET_LOGGING_ENABLED"]);
    addCfnGuardSuppression(loggingBucket, ["S3_BUCKET_LOGGING_ENABLED"]);
    addCfnGuardSuppression(distribution, [
      "CLOUDFRONT_MINIMUM_PROTOCOL_VERSION_RULE",
    ]);

    // the lambda function BucketDeployment creates isn't exposed as a public attribute and
    // that node doesn't have a defaultChild as a CfnResource, so the function addCfnGuardSuppression fails
    // find the resource from the stack and by traversing the node tree
    const cdkDeployLambdas = Stack.of(this)
      .node.findAll()
      .filter((node) => {
        return (
          (node as CfnResource).cfnResourceType === "AWS::Lambda::Function" &&
          node.node.path.includes("Custom::CDKBucketDeployment")
        );
      }) as CfnResource[];

    if (cdkDeployLambdas.length === 1) {
      const lambdaFunction = cdkDeployLambdas[0]!;
      lambdaFunction.addMetadata("guard", {
        SuppressedRules: ["LAMBDA_INSIDE_VPC", "LAMBDA_CONCURRENCY_CHECK"],
      });
    } else {
      throw new Error(
        "Can't find the lambda function created by aws_s3_deployment.BucketDeployment, unable to add cfn-guard suppression",
      );
    }
  }
}
