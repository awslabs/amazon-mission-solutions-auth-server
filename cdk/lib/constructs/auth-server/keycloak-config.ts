/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { CustomResource, RemovalPolicy } from 'aws-cdk-lib';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { KeycloakCustomConfig } from '../../utils/keycloak-config-loader';
import { KeycloakConfigLambda } from './keycloak-config-lambda';

export interface KeycloakConfigProps {
  /**
   * The shared Keycloak config Lambda infrastructure. A single
   * {@link KeycloakConfigLambda} is deployed once per environment and can
   * back multiple {@link KeycloakConfig} instances — one per realm.
   */
  keycloakConfigLambda: KeycloakConfigLambda;
  /** Custom auth configuration (from deployment.json dataplaneConfig.KEYCLOAK_AUTH_CONFIG). */
  customAuthConfig?: KeycloakCustomConfig;
  /** Whether to generate passwords for users. */
  generateUserPasswords?: boolean;
}

/**
 * Keycloak Config construct for the Auth Server.
 *
 * Creates a per-realm CloudFormation Custom Resource that invokes the shared
 * {@link KeycloakConfigLambda} to configure Keycloak with realms, clients,
 * and users. Also provisions per-user password secrets when
 * `generateUserPasswords` is enabled.
 */
export class KeycloakConfig extends Construct {
  public readonly userPasswordSecrets: Map<string, Secret> = new Map();
  public readonly customResource: CustomResource;

  constructor(scope: Construct, id: string, props: KeycloakConfigProps) {
    super(scope, id);

    const lambda = props.keycloakConfigLambda;
    const generateUserPasswords = props.generateUserPasswords !== false;
    const authConfig = props.customAuthConfig;

    // User password secrets are per-realm, so they live with the CustomResource.
    if (authConfig && generateUserPasswords && authConfig.users) {
      authConfig.users.forEach(user => {
        if (user.generatePassword) {
          const relativePath = user.ssmPasswordPath || `users/${user.username}/password`;
          const cleanRelativePath = relativePath.replace(/^\//, '');
          const secretName = `${lambda.projectName}-auth/${cleanRelativePath}`;

          const secret = new Secret(this, `UserPassword-${user.username}`, {
            secretName: secretName,
            description: `Password for Keycloak user ${user.username}`,
            generateSecretString: {
              passwordLength: 16,
              excludePunctuation: false,
              includeSpace: false,
              requireEachIncludedType: true,
            },
            removalPolicy: lambda.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
          });

          this.userPasswordSecrets.set(user.username, secret);
        }
      });
    }

    // Grant the shared config Lambda role read/write access to this realm's
    // password secrets so it can persist generated values back to Keycloak.
    this.userPasswordSecrets.forEach(secret => {
      secret.grantRead(lambda.lambdaRoles.configLambdaRole);
      secret.grantWrite(lambda.lambdaRoles.configLambdaRole);
    });

    // Build the user password secrets map (username -> secret ARN).
    const userPasswordSecretArns = Array.from(this.userPasswordSecrets.entries()).reduce(
      (obj, [username, secret]) => {
        obj[username] = secret.secretArn;
        return obj;
      },
      {} as Record<string, string>,
    );

    this.customResource = new CustomResource(this, 'CustomResource', {
      serviceToken: lambda.provider.serviceToken,
      resourceType: 'Custom::KeycloakConfig',
      properties: {
        SsmPrefix: lambda.ssmPrefix,
        KeycloakAdminUsername: lambda.keycloakAdminUsername,
        AuthConfig: JSON.stringify(authConfig ?? {}),
        UserPasswordSecrets: userPasswordSecretArns,
      },
    });

    // CDK-NAG suppressions for per-user password secrets.
    this.userPasswordSecrets.forEach(secret => {
      NagSuppressions.addResourceSuppressions(secret, [
        {
          id: 'AwsSolutions-SMG4',
          reason:
            'User password secrets are generated at deployment time for Keycloak user provisioning. Rotation is not applicable as passwords are managed through Keycloak.',
        },
      ]);
    });
  }
}
