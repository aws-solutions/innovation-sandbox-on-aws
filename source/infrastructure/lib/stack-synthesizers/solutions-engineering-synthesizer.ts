// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DefaultStackSynthesizer,
  type DefaultStackSynthesizerProps,
  type FileAssetLocation,
  type FileAssetSource,
  ISynthesisSession,
} from "aws-cdk-lib";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

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
    super.synthesize(session);
    // Wait (arbitrary 1 sec) for  the assembly to be written to disk
    setTimeout(() => {
      this.removeAwsLanguageExtensions(session);
    }, 1000);
  }
}
