/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { createRemoteJWKSet, jwtVerify, type JWTVerifyResult } from 'jose';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StackOutputs {
  keycloakUrl: string;
  adminSecretArn: string;
  loadBalancerDns: string;
}

export interface AdminCredentials {
  username: string;
  password: string;
}

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

// ---------------------------------------------------------------------------
// Internal HTTP helpers (avoid external deps like axios in test code)
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  cookies: string[];
  body: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

function parseCookies(headers: http.IncomingHttpHeaders): string[] {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  return raw.map(c => c.split(';')[0]);
}

function mergeCookies(existing: string[], newCookies: string[]): string[] {
  const map = new Map<string, string>();
  for (const c of [...existing, ...newCookies]) {
    const name = c.split('=')[0];
    map.set(name, c);
  }
  return Array.from(map.values());
}

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    cookies?: string[];
    followRedirects?: boolean;
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.cookies?.length) {
      headers['Cookie'] = options.cookies.join('; ');
    }
    const reqOptions: https.RequestOptions = {
      method: options.method ?? 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      rejectUnauthorized: true,
    };

    const req = lib.request(reqOptions, res => {
      // Collect cookies from this response
      const responseCookies = mergeCookies(options.cookies ?? [], parseCookies(res.headers));

      // Handle redirects internally when needed
      if (
        options.followRedirects !== false &&
        res.statusCode &&
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        httpRequest(redirectUrl, {
          ...options,
          method: 'GET',
          body: undefined,
          cookies: responseCookies,
        })
          .then(resolve)
          .catch(reject);
        res.resume(); // drain the response
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          cookies: responseCookies,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// AWS Helpers (uses AWS CLI to avoid SDK v3 dynamic-import issues in Jest)
// ---------------------------------------------------------------------------

function awsCli(args: string[]): string {
  return execFileSync('aws', args, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
}

export function getStackOutputs(projectName: string, region: string): StackOutputs {
  const stackName = `${projectName}-Dataplane`;
  const raw = awsCli([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    stackName,
    '--region',
    region,
    '--output',
    'json',
  ]);
  const parsed = JSON.parse(raw) as {
    Stacks?: { Outputs?: { OutputKey: string; OutputValue: string; ExportName?: string }[] }[];
  };
  const outputs = parsed.Stacks?.[0]?.Outputs ?? [];

  // Match on ExportName (stable) since OutputKey includes CDK-generated suffixes
  const getByExport = (exportName: string): string => {
    const o = outputs.find(o => o.ExportName === exportName);
    if (!o?.OutputValue) {
      throw new Error(`Stack export ${exportName} not found in ${stackName}`);
    }
    return o.OutputValue;
  };

  return {
    keycloakUrl: getByExport(`${projectName}-KeycloakUrl`),
    adminSecretArn: getByExport(`${projectName}-KeycloakAdminSecretArn`),
    loadBalancerDns: getByExport(`${projectName}-LoadBalancerDNS`),
  };
}

export function getSecretValue(arn: string, region: string): string {
  const raw = awsCli([
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    arn,
    '--region',
    region,
    '--output',
    'json',
  ]);
  const parsed = JSON.parse(raw) as { SecretString?: string };
  if (!parsed.SecretString) throw new Error(`Secret ${arn} has no string value`);
  return parsed.SecretString;
}

export function getAdminCredentials(arn: string, region: string): AdminCredentials {
  const raw = getSecretValue(arn, region);
  const parsed = JSON.parse(raw) as { username: string; password: string };
  return { username: parsed.username, password: parsed.password };
}

export function getUserPassword(
  projectName: string,
  username: string,
  region: string,
  ssmPasswordPath?: string,
): string {
  const relativePath = ssmPasswordPath ?? `users/${username}/password`;
  const cleanPath = relativePath.replace(/^\//, '');
  const secretName = `${projectName}-auth/${cleanPath}`;
  return getSecretValue(secretName, region);
}

// ---------------------------------------------------------------------------
// Keycloak Admin API Helpers
// ---------------------------------------------------------------------------

export async function getAdminToken(
  keycloakUrl: string,
  username: string,
  password: string,
): Promise<string> {
  const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    username,
    password,
    grant_type: 'password',
    client_id: 'admin-cli',
  }).toString();

  const resp = await httpRequest(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    followRedirects: false,
  });

  if (resp.statusCode !== 200) {
    throw new Error(`Admin token request failed (${resp.statusCode}): ${resp.body}`);
  }
  const data = JSON.parse(resp.body) as { access_token?: string };
  if (!data.access_token) throw new Error('Admin token response missing access_token');
  return data.access_token;
}

export async function getRealmDetails(
  keycloakUrl: string,
  adminToken: string,
  realm: string,
): Promise<Record<string, unknown>> {
  const url = `${keycloakUrl}/admin/realms/${encodeURIComponent(realm)}`;
  const resp = await httpRequest(url, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Get realm failed (${resp.statusCode}): ${resp.body}`);
  }
  return JSON.parse(resp.body) as Record<string, unknown>;
}

export async function getClients(
  keycloakUrl: string,
  adminToken: string,
  realm: string,
): Promise<Record<string, unknown>[]> {
  const url = `${keycloakUrl}/admin/realms/${encodeURIComponent(realm)}/clients`;
  const resp = await httpRequest(url, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Get clients failed (${resp.statusCode}): ${resp.body}`);
  }
  return JSON.parse(resp.body) as Record<string, unknown>[];
}

export async function getUsers(
  keycloakUrl: string,
  adminToken: string,
  realm: string,
): Promise<Record<string, unknown>[]> {
  const url = `${keycloakUrl}/admin/realms/${encodeURIComponent(realm)}/users`;
  const resp = await httpRequest(url, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`Get users failed (${resp.statusCode}): ${resp.body}`);
  }
  return JSON.parse(resp.body) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Auth Code + PKCE Helpers
// ---------------------------------------------------------------------------

export function generatePkce(): PkceChallenge {
  const codeVerifier = randomBytes(32)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9\-._~]/g, '')
    .slice(0, 128);

  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  return { codeVerifier, codeChallenge };
}

export function resolveRedirectUri(clientConfig: {
  redirectUris?: string[];
  websiteUri?: string;
}): string | undefined {
  const uris = clientConfig.redirectUris ?? [];
  for (const uri of uris) {
    // Skip placeholders — these get resolved by the Lambda at deploy time
    if (uri.startsWith('__PLACEHOLDER')) continue;
    // If it's a concrete URI without a wildcard, use it directly
    if (uri.startsWith('http') && !uri.endsWith('*')) return uri;
    // If it ends with /*, derive a concrete path the wildcard will match
    if (uri.startsWith('http') && uri.endsWith('/*')) {
      return uri.replace(/\/\*$/, '/callback');
    }
  }
  // All URIs were placeholders — if websiteUri is set, the Lambda registered
  // ${websiteUri}/* so we can derive a matching concrete URI from it
  if (clientConfig.websiteUri) {
    return `${clientConfig.websiteUri}/callback`;
  }
  return undefined;
}

/**
 * Perform the full Auth Code + PKCE flow by simulating browser interactions.
 *
 * 1. GET the authorization endpoint → Keycloak returns a login page.
 * 2. Parse the login form action URL from the HTML.
 * 3. POST credentials to the form action → Keycloak redirects with ?code=.
 * 4. Exchange the code for tokens at the token endpoint.
 */
export async function performAuthCodeFlow(
  keycloakUrl: string,
  realm: string,
  clientId: string,
  redirectUri: string,
  username: string,
  password: string,
): Promise<TokenSet> {
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = randomBytes(16).toString('hex');

  // Step 1: Hit the authorize endpoint
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const authorizeUrl = `${keycloakUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/auth?${authParams}`;

  // Don't follow redirects — we need the login page HTML and cookies
  const authResp = await httpRequest(authorizeUrl, { followRedirects: false });

  // Keycloak may return 200 (login page) or redirect to the login page
  let loginPageHtml: string;
  let sessionCookies: string[] = authResp.cookies;
  if (authResp.statusCode === 200) {
    loginPageHtml = authResp.body;
  } else if (
    authResp.statusCode &&
    [301, 302, 303].includes(authResp.statusCode) &&
    authResp.headers.location
  ) {
    const loginResp = await httpRequest(authResp.headers.location, {
      followRedirects: false,
      cookies: sessionCookies,
    });
    loginPageHtml = loginResp.body;
    sessionCookies = loginResp.cookies;
  } else {
    throw new Error(
      `Unexpected authorize response (${authResp.statusCode}): ${authResp.body.slice(0, 500)}`,
    );
  }

  // Step 2: Extract form action URL from the login page
  const formActionMatch = loginPageHtml.match(/action="([^"]+)"/);
  if (!formActionMatch) {
    throw new Error(
      `Could not find login form action in Keycloak login page. HTML snippet: ${loginPageHtml.slice(0, 1000)}`,
    );
  }
  // Keycloak HTML-encodes & as &amp; in the action URL
  const formAction = formActionMatch[1].replace(/&amp;/g, '&');

  // Step 3: POST credentials with session cookies — don't follow redirects so we can capture the code
  const loginBody = new URLSearchParams({ username, password }).toString();
  const loginResp = await httpRequest(formAction, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: loginBody,
    cookies: sessionCookies,
    followRedirects: false,
  });

  if (!loginResp.headers.location) {
    throw new Error(
      `Login POST did not redirect (${loginResp.statusCode}): ${loginResp.body.slice(0, 500)}`,
    );
  }

  const callbackUrl = new URL(loginResp.headers.location);
  const authCode = callbackUrl.searchParams.get('code');
  if (!authCode) {
    const error = callbackUrl.searchParams.get('error');
    const errorDesc = callbackUrl.searchParams.get('error_description');
    throw new Error(`No authorization code in callback. error=${error}, description=${errorDesc}`);
  }

  // Verify state matches
  const returnedState = callbackUrl.searchParams.get('state');
  if (returnedState !== state) {
    throw new Error(`State mismatch: expected ${state}, got ${returnedState}`);
  }

  // Step 4: Exchange code for tokens
  const tokenUrl = `${keycloakUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`;
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: authCode,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  }).toString();

  const tokenResp = await httpRequest(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
    followRedirects: false,
  });

  if (tokenResp.statusCode !== 200) {
    throw new Error(`Token exchange failed (${tokenResp.statusCode}): ${tokenResp.body}`);
  }

  const tokens = JSON.parse(tokenResp.body) as {
    access_token: string;
    refresh_token: string;
    id_token: string;
  };
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
  };
}

// ---------------------------------------------------------------------------
// Token Validation
// ---------------------------------------------------------------------------

export async function verifyTokenWithJwks(
  token: string,
  jwksUri: string,
  expectedIssuer: string,
): Promise<JWTVerifyResult> {
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  return jwtVerify(token, jwks, {
    issuer: expectedIssuer,
  });
}

// ---------------------------------------------------------------------------
// Userinfo
// ---------------------------------------------------------------------------

export async function getUserInfo(
  keycloakUrl: string,
  realm: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const url = `${keycloakUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/userinfo`;
  const resp = await httpRequest(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (resp.statusCode !== 200) {
    throw new Error(`UserInfo request failed (${resp.statusCode}): ${resp.body}`);
  }
  return JSON.parse(resp.body) as Record<string, unknown>;
}
