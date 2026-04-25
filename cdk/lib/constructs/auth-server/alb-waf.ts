/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { RemovalPolicy } from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnLoggingConfiguration, CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

/** Configuration for the ALB WAFv2 WebACL. */
export interface AlbWafProps {
  /** ARN of the ALB to associate with the WebACL. */
  readonly loadBalancerArn: string;
  /** Project name used to derive resource names. */
  readonly projectName: string;
  /** Whether this is a prod-like environment (affects log retention). */
  readonly isProd: boolean;
  /** Per-IP rate limit within a 5-minute sliding window. Default: 2000. */
  readonly requestsPer5Min?: number;
}

/**
 * WAFv2 WebACL attached to an internet-facing ALB.
 * Provides rate limiting and known-bad-inputs protection.
 */
export class AlbWaf extends Construct {
  public readonly webAcl: CfnWebACL;

  constructor(scope: Construct, id: string, props: AlbWafProps) {
    super(scope, id);

    const rateLimit = props.requestsPer5Min ?? 2000;
    const namePrefix = `${props.projectName}-auth-waf`;

    this.webAcl = new CfnWebACL(this, 'WebAcl', {
      name: namePrefix,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${namePrefix}-metric`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimitPerIp',
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: rateLimit,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitPerIp',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // WAF log group names must be prefixed with "aws-waf-logs-"
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `aws-waf-logs-${namePrefix}`,
      retention: props.isProd ? RetentionDays.ONE_YEAR : RetentionDays.ONE_MONTH,
      removalPolicy: props.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    new CfnLoggingConfiguration(this, 'LoggingConfig', {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [logGroup.logGroupArn],
    });

    new CfnWebACLAssociation(this, 'AlbAssociation', {
      resourceArn: props.loadBalancerArn,
      webAclArn: this.webAcl.attrArn,
    });
  }
}
