// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCloudFormationTemplateServices } from "@amzn/innovation-sandbox-commons/utils/stack-set-parser.js";
import { describe, expect, it } from "vitest";

describe("getCloudFormationTemplateServices", () => {
  describe("basic functionality", () => {
    it("should extract and count AWS services from resource types", () => {
      const resourceTypes = [
        "AWS::S3::Bucket",
        "AWS::Lambda::Function",
        "AWS::DynamoDB::Table",
      ];

      const services = getCloudFormationTemplateServices(resourceTypes);

      expect(services).toEqual({ DynamoDB: 1, Lambda: 1, S3: 1 });
    });

    it("should count multiple resources of same service", () => {
      const resourceTypes = [
        "AWS::S3::Bucket",
        "AWS::S3::Bucket",
        "AWS::Lambda::Function",
      ];

      const services = getCloudFormationTemplateServices(resourceTypes);

      expect(services).toEqual({ Lambda: 1, S3: 2 });
    });
  });

  describe("custom resources", () => {
    it("should detect and count custom resources", () => {
      const resourceTypes = ["Custom::MyCustomType"];

      const services = getCloudFormationTemplateServices(resourceTypes);

      expect(services).toEqual({ CustomResource: 1 });
    });

    it("should combine and count AWS services and custom resources", () => {
      const resourceTypes = [
        "AWS::S3::Bucket",
        "Custom::MyCustomType",
        "AWS::DynamoDB::Table",
      ];

      const services = getCloudFormationTemplateServices(resourceTypes);

      expect(services).toEqual({ CustomResource: 1, DynamoDB: 1, S3: 1 });
    });

    it("should count multiple custom resources", () => {
      const resourceTypes = ["Custom::Type1", "Custom::Type2"];

      const services = getCloudFormationTemplateServices(resourceTypes);

      expect(services).toEqual({ CustomResource: 2 });
    });
  });

  describe("edge cases", () => {
    it("should return empty object for empty array", () => {
      const services = getCloudFormationTemplateServices([]);

      expect(services).toEqual({});
    });

    it("should ignore invalid resource type formats", () => {
      const resourceTypes = [
        "AWS::S3::Bucket",
        "InvalidType",
        "NotAWS::Something",
      ];

      const services = getCloudFormationTemplateServices(resourceTypes);

      expect(services).toEqual({ S3: 1 });
    });
  });

  describe("EC2 special cases", () => {
    it("should extract VPC as separate service from EC2", () => {
      const resourceTypes = ["AWS::EC2::VPC", "AWS::EC2::Instance"];

      const services = getCloudFormationTemplateServices(resourceTypes);

      expect(services).toEqual({ EC2: 1, VPC: 1 });
    });

    it("should extract TransitGateway as separate service from EC2", () => {
      const resourceTypes = ["AWS::EC2::TransitGateway", "AWS::EC2::Instance"];

      const services = getCloudFormationTemplateServices(resourceTypes);

      expect(services).toEqual({ EC2: 1, TransitGateway: 1 });
    });
  });

  describe("real-world example", () => {
    it("should count services in a typical web application stack", () => {
      const resourceTypes = [
        "AWS::S3::Bucket",
        "AWS::CloudFront::Distribution",
        "AWS::DynamoDB::Table",
        "AWS::Lambda::Function",
        "AWS::ApiGateway::RestApi",
        "AWS::IAM::Role",
        "Custom::SlackNotification",
      ];

      const services = getCloudFormationTemplateServices(resourceTypes);

      expect(services).toEqual({
        ApiGateway: 1,
        CloudFront: 1,
        CustomResource: 1,
        DynamoDB: 1,
        IAM: 1,
        Lambda: 1,
        S3: 1,
      });
    });
  });
});
