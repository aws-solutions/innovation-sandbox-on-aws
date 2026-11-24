// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  Aspects,
  CfnCondition,
  CfnOutput,
  CfnResource,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Token,
} from "aws-cdk-lib";
import { RestApiBase as ApiGatewayRestApi } from "aws-cdk-lib/aws-apigateway";
import {
  AllowedMethods,
  CachePolicy,
  CfnDistribution,
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
import { existsSync, rmSync } from "fs-extra";
import { execSync } from "node:child_process";
import path from "node:path";

import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { IsbLogGroups } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-groups";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { ConditionAspect } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import {
  MCP_CLIENT_CALLBACK_URLS,
  isDevMode,
} from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";

export interface CloudFrontUiApiProps {
  restApi: ApiGatewayRestApi;
  namespace: string;
  cognitoUserPoolId: string;
  cognitoAppClientId: string;
  cognitoMcpClientId: string;
  cognitoIdentityPoolId: string;
  cognitoDomain: string;
  awsAccessPortalUrl: string;
  webSocketUrl: string;
  mcpGatewayUrl: string;
  customDomainName: string;
  customDomainCertificateArn: string;
}

export class CloudfrontUiApi extends Construct {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: CloudFrontUiApiProps) {
    super(scope, id);
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);

    // Define regions that don't support CloudFront standard access logging
    const unsupportedLoggingRegions = [
      "af-south-1", // Africa (Cape Town)
      "ap-east-1", // Asia Pacific (Hong Kong)
      "ap-south-2", // Asia Pacific (Hyderabad)
      "ap-southeast-3", // Asia Pacific (Jakarta)
      "ap-southeast-4", // Asia Pacific (Melbourne)
      "ca-west-1", // Canada West (Calgary)
      "eu-south-1", // Europe (Milan)
      "eu-south-2", // Europe (Spain)
      "eu-central-2", // Europe (Zurich)
      "il-central-1", // Israel (Tel Aviv)
      "me-south-1", // Middle East (Bahrain)
      "me-central-1", // Middle East (UAE)
    ];

    const supportsCloudFrontLogging = new CfnCondition(
      this,
      "SupportsCloudFrontLogging",
      {
        expression: Fn.conditionNot(
          Fn.conditionOr(
            ...unsupportedLoggingRegions.map((region) =>
              Fn.conditionEquals(Fn.ref("AWS::Region"), region),
            ),
          ),
        ),
      },
    );

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

    // Apply condition to logging bucket - only create in supported regions
    Aspects.of(loggingBucket).add(
      new ConditionAspect(supportsCloudFrontLogging),
    );

    const oac = new S3OriginAccessControl(
      this,
      "IsbCloudFrontDistributionOac",
      {
        originAccessControlName: `${props.namespace}-IsbCloudFrontDistributionOac`,
        signing: Signing.SIGV4_ALWAYS,
      },
    );

    const connectSrcDirectives = [
      "'self'",
      "https://api.github.com",
      `https://${props.cognitoDomain}.auth.${Stack.of(this).region}.amazoncognito.com`,
      `https://cognito-idp.${Stack.of(this).region}.amazonaws.com`,
      `https://cognito-identity.${Stack.of(this).region}.amazonaws.com`,
      props.webSocketUrl,
    ];

    const responseHeadersPolicy = new ResponseHeadersPolicy(
      this,
      "IsbCloudFrontResponseHeadersPolicy",
      {
        responseHeadersPolicyName: `${props.namespace}-IsbCloudFrontResponseHeadersPolicy`,
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
              `connect-src ${connectSrcDirectives.join(" ")};`,
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
        removeHeaders: [
          "x-amz-server-side-encryption",
          "x-amz-server-side-encryption-aws-kms-key-id",
          "x-amz-version-id",
        ],
      },
    );

    const apiResponseHeadersPolicy = new ResponseHeadersPolicy(
      this,
      "IsbApiCloudFrontResponseHeadersPolicy",
      {
        responseHeadersPolicyName: `${props.namespace}-IsbApiCloudFrontResponseHeadersPolicy`,
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
        functionName: `${props.namespace}-IsbPathRewriteCloudFrontFunction`,
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
        functionName: `${props.namespace}-IsbS3OriginPathRedirectCloudFrontFunction`,
        code: CloudFrontFunctionCode.fromInline(String.raw`
          function handler(event) {
            var request = event.request;
            var uri = request.uri;
            // A dot after the last slash = the last segment has a file extension
            // (e.g. /assets/app.js) -> serve as-is; otherwise it's a client-side route.
            // No regex on purpose: a prior version used request.uri.split(/\#|\?/)
            // and a long URI (e.g. a ~127-char base64 leaseId path) failed with
            // "RangeError: Regex execute instruction limit exceeded" -> 503,
            // probably the regex evaluation exceeding its time/step budget.
            var slash = uri.lastIndexOf("/");
            var dot = uri.lastIndexOf(".");
            if (dot > slash) return request;
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
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      enableIpv6: false,
    });

    // Conditionally disable logging in unsupported regions by overriding the entire Logging property
    const cfnDistribution = distribution.node.defaultChild as CfnDistribution;
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Logging",
      Fn.conditionIf(
        supportsCloudFrontLogging.logicalId,
        {
          Bucket: loggingBucket.bucketDomainName,
          IncludeCookies: true,
          Prefix: "isb-fe-logs/",
        },
        Fn.ref("AWS::NoValue"),
      ),
    );

    // Attach the custom domain alias + ACM certificate only when both a domain
    // and a us-east-1 certificate are provided. A domain without a certificate
    // is the "front ISB with your own edge" case: the base URL is set elsewhere
    // but the distribution keeps its default certificate.
    const attachCustomDomain = new CfnCondition(this, "AttachCustomDomain", {
      expression: Fn.conditionAnd(
        Fn.conditionNot(Fn.conditionEquals(props.customDomainName, "")),
        Fn.conditionNot(
          Fn.conditionEquals(props.customDomainCertificateArn, ""),
        ),
      ),
    });

    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Aliases",
      Fn.conditionIf(
        attachCustomDomain.logicalId,
        [props.customDomainName],
        Fn.ref("AWS::NoValue"),
      ),
    );

    cfnDistribution.addPropertyOverride(
      "DistributionConfig.ViewerCertificate",
      Fn.conditionIf(
        attachCustomDomain.logicalId,
        {
          AcmCertificateArn: props.customDomainCertificateArn,
          SslSupportMethod: "sni-only",
          MinimumProtocolVersion: "TLSv1.2_2021",
        },
        Fn.ref("AWS::NoValue"),
      ),
    );

    new BucketDeployment(this, "DeployIsbFrontEnd", {
      sources: [
        Source.asset(
          buildFrontend(
            path.join(__dirname, "..", "..", "..", "..", "frontend"),
          ),
        ),
        Source.jsonData("config.json", {
          CognitoUserPoolId: props.cognitoUserPoolId,
          CognitoAppClientId: props.cognitoAppClientId,
          CognitoIdentityPoolId: props.cognitoIdentityPoolId,
          CognitoDomain: props.cognitoDomain,
          Region: Stack.of(this).region,
          AwsAccessPortalUrl: props.awsAccessPortalUrl,
          ApiGatewayHost: `${props.restApi.restApiId}.execute-api.${Stack.of(this).region}.${Stack.of(this).urlSuffix}`,
          ApiGatewayStage: props.restApi.deploymentStage.stageName,
          SandboxAgentWebSocketUrl: props.webSocketUrl,
          SandboxAgentMcpGatewayUrl: props.mcpGatewayUrl,
          CognitoMcpClientId: props.cognitoMcpClientId,
          CognitoMcpCallbackUrls: MCP_CLIENT_CALLBACK_URLS,
        }),
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

    feBucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ["s3:ListBucket"],
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
        resources: [feBucket.bucketArn],
        conditions: {
          StringEquals: {
            "AWS:SourceArn": `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${distribution.distributionId}`,
          },
        },
      }),
    );

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

    this.distributionDomainName = distribution.distributionDomainName;

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

/**
 * Builds the frontend application at synth time and returns the dist path
 */
function buildFrontend(frontendPath: string): string {
  const distPath = path.join(frontendPath, "dist");

  if (existsSync(distPath)) {
    console.log(`Cleaning existing dist directory: ${distPath}`);
    rmSync(distPath, { recursive: true });
  }

  console.log(`Building frontend at ${frontendPath}...`);

  try {
    //prettier-ignore
    execSync("npm run build", { // NOSONAR typescript:S4036 - only used in cdk synth process
      cwd: frontendPath,
      stdio: "inherit",
    })

    console.log(`Frontend build completed successfully at ${distPath}`);
    return distPath;
  } catch (error) {
    console.error(`Frontend build failed: ${error}`);
    throw new Error(`Failed to build frontend: ${error}`);
  }
}
