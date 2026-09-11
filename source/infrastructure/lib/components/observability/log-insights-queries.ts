// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { CfnQueryDefinition } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface LogInsightsQueryProps {
  namespace: string;
}

export class LogInsightsQueries extends Construct {
  constructor(scope: Construct, id: string, props: LogInsightsQueryProps) {
    super(scope, id);

    const query_root_folder = `ISB-${props.namespace}/`;

    new CfnQueryDefinition(this, "LogQuery", {
      name: query_root_folder + "LogQuery",
      logGroupNames: [IsbComputeResources.globalLogGroup.logGroupName],
      queryString: `# Innovation Sandbox Log Query
# Remember to set the time range for this log query in the widget above
fields @timestamp, @message
# Replace /PasteReferenceIDHere/ with a reference ID such as an AWS Account ID,
# Lease UUID, user email address, or other unique identifier
| filter @message like /PasteReferenceIDHere/
| filter isPresent(message) or isPresent(errorMessage) or isPresent(message.errorMessage)
| filter level != 'DEBUG'
| filter message != 'Lambda invocation event'
| sort @timestamp desc
| display @timestamp, concat(message, message.errorMessage, errorMessage) as msg`,
    });

    new CfnQueryDefinition(this, "ErrorsLogs", {
      name: query_root_folder + "ErrorLogs",
      logGroupNames: [IsbComputeResources.globalLogGroup.logGroupName],
      queryString: `# Innovation Sandbox Errors Query
# View all errors and warnings that have been raised by the core operational
# components of Innovation Sandbox
# Remember to set the time range for this log query in the widget above
fields @timestamp, @message, message.errorMessage
| filter level = 'ERROR' or level = "WARN"
| filter message != 'Lambda invocation event'
| sort @timestamp desc
| display @timestamp, level, concat(message, message.errorMessage, errorMessage) as msg`,
    });

    new CfnQueryDefinition(this, "AccountCleanupLogs", {
      name: query_root_folder + "AccountCleanupLogs",
      logGroupNames: [IsbComputeResources.cleanupLogGroup.logGroupName],
      queryString: `# Innovation Sandbox Account Cleanup Logs
# View all logs from a single account cleanup build.
# Results show resource deletion failures that occurred and aws nuke summary logs.
# Remember to set the time range for this log query in the widget above
fields @timestamp, type as resourceType, owner as region, name, msg
# Replace /PasteCodeBuildBuildIdHere/ with the CodeBuild build id of the nuke phase under investigation.
# To find it, open the account details page in the web UI, choose the failed cleanup
# report, and use the "View build logs" link on the nuke phase step.
| filter @logStream like /PasteCodeBuildBuildIdHere/
| filter # Comment out this filter to see all logs from the build.
  component = "libnuke"
   or state = "failed"
| sort time desc`,
    });
  }
}
