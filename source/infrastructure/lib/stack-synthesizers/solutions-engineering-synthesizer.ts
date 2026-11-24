// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DefaultStackSynthesizer,
  type DefaultStackSynthesizerProps,
  type FileAssetLocation,
  type FileAssetSource,
  ISynthesisSession,
} from "aws-cdk-lib";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLOUDFORMATION_TEMPLATE_LIMIT_BYTES = 1_000_000;
const CLOUDFORMATION_TEMPLATE_WARNING_BYTES = 900_000;

// CloudFormation rejects templates larger than 1,000,000 bytes. CDK emits
// pretty-printed JSON, so reserializing without indentation removes only
// insignificant whitespace; it does not remove or restructure resources. The
// reported local file size is advisory because packaging is the final authority.
export function compactCloudFormationTemplates(outDir: string): void {
  const templateFiles = fs
    .readdirSync(outDir)
    .filter((file) => file.endsWith(".template.json"));
  templateFiles.forEach((file) => {
    const templatePath = path.join(outDir, file);
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    const compacted = JSON.stringify(template, null, 0);
    fs.writeFileSync(templatePath, compacted);

    const sizeBytes = fs.statSync(templatePath).size;
    const lineCount = compacted.split("\n").length;
    console.log(
      `${file} compacted size: ${sizeBytes} bytes (${lineCount} line${lineCount === 1 ? "" : "s"})`,
    );
    if (sizeBytes > CLOUDFORMATION_TEMPLATE_LIMIT_BYTES) {
      console.error(
        `CRITICAL WARNING: ${file} exceeds CloudFormation's ${CLOUDFORMATION_TEMPLATE_LIMIT_BYTES}-byte template limit after compaction. CloudFormation may reject the packaged template.`,
      );
    } else if (sizeBytes >= CLOUDFORMATION_TEMPLATE_WARNING_BYTES) {
      console.warn(
        `WARNING: ${file} is approaching CloudFormation's ${CLOUDFORMATION_TEMPLATE_LIMIT_BYTES}-byte template limit.`,
      );
    }
  });
}

interface SolutionsEngineeringSynthesizerProps extends DefaultStackSynthesizerProps {
  outdir: string;
}

export class SolutionsEngineeringSynthesizer extends DefaultStackSynthesizer {
  readonly outdir: string;

  constructor(props: SolutionsEngineeringSynthesizerProps) {
    super(props);
    this.outdir = path.resolve(props.outdir);
  }

  override addFileAsset(asset: FileAssetSource): FileAssetLocation {
    const fileAssetLocation = super.addFileAsset(asset);

    if (
      asset.fileName &&
      asset.packaging === "zip" &&
      !path.isAbsolute(asset.fileName)
    ) {
      const assetDir = path.join(this.outdir, asset.fileName);
      const zipFileName = `${path.basename(asset.fileName)}.zip`;
      const zipFilePath = path.join(this.outdir, zipFileName);

      // prettier-ignore
      execSync(`cd ${assetDir} && zip -r ${zipFilePath} .`, { // NOSONAR typescript:S4721 - this is required as part of the CDK synthesis process
        stdio: "ignore",
      });
    }
    return fileAssetLocation;
  }

  /**
   * Removes the AWS::LanguageExtensions transform from the assembly file
   * CDK synthesis is generating CFN templates with this transform even though the transform is not needed
   * When stacks contain this transform CFN console updates that contain `Use existing value` do not work
   * This behavior is documented here - https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/transform-aws-languageextensions.html
   * This transform isn't included in the snapshot of the CDK assembly
   * Thus this change didn't result in cdk snapshot update
   * Thus the node can't be remove from the L1 construct or using aspects
   * So we need to remove it manually here after synthesis
   * @param session
   */
  protected removeAwsLanguageExtensions(session: ISynthesisSession) {
    const outDir = session.assembly.outdir;
    const files = fs.readdirSync(outDir);
    const templateFiles = files.filter((f) => f.endsWith(".template.json"));

    templateFiles.forEach((templateFile) => {
      const templatePath = `${outDir}/${templateFile}`;
      console.log(`Inspecting ${templateFile} for AWS::LanguageExtensions`);
      const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
      let modified = false;
      if (template.Transform === "AWS::LanguageExtensions") {
        console.log(
          `${templateFile} - Removing Transform node which was AWS::LanguageExtensions`,
        );
        delete template.Transform;
        modified = true;
      }

      if (template.Transform && Array.isArray(template.Transform)) {
        const originalLength = template.Transform.length;
        template.Transform = template.Transform.filter(
          (t: string) => t !== "AWS::LanguageExtensions",
        );

        if (template.Transform.length === 0) {
          modified = true;
          console.log(
            `${templateFile} - Removing Transform node which was [AWS::LanguageExtensions]`,
          );
          delete template.Transform;
        } else if (template.Transform.length !== originalLength) {
          console.log(
            `${templateFile} - Removing AWS::LanguageExtensions entry from Transform array node`,
          );
          modified = true;
        }
      }
      if (modified) {
        fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
        console.log(`${templateFile} successfully modified`);
      }
    });
  }

  override synthesize(session: ISynthesisSession): void {
    // super.synthesize writes this stack's template synchronously; post-process
    // it here (idempotent, re-sweeps the whole outdir) rather than on a timer.
    super.synthesize(session);
    this.removeAwsLanguageExtensions(session);
    compactCloudFormationTemplates(session.assembly.outdir);
  }
}
