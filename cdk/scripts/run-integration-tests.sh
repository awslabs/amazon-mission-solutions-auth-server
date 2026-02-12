#!/usr/bin/env bash
# Copyright 2025 Amazon.com, Inc. or its affiliates.
#
# Pre-flight wrapper for integration tests.
# Usage: ./scripts/run-integration-tests.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOYMENT_JSON="${CDK_DIR}/bin/deployment/deployment.json"

# ── Pre-flight checks ──────────────────────────────────────────────────────

echo "==> Checking AWS credentials..."
if ! aws sts get-caller-identity &>/dev/null; then
  echo "ERROR: AWS credentials not available or expired."
  echo "       Run 'ada credentials update' or configure AWS_PROFILE."
  exit 1
fi
echo "    OK ($(aws sts get-caller-identity --query 'Account' --output text))"

echo "==> Checking deployment.json..."
if [[ ! -f "${DEPLOYMENT_JSON}" ]]; then
  echo "ERROR: ${DEPLOYMENT_JSON} not found."
  echo "       Copy deployment.json.example and configure for your environment."
  exit 1
fi
echo "    OK"

echo "==> Resolving Keycloak URL from deployment.json..."
PROJECT_NAME=$(node -e "console.log(require('${DEPLOYMENT_JSON}').projectName)")
REGION=$(node -e "console.log(require('${DEPLOYMENT_JSON}').account.region)")

KEYCLOAK_URL=$(aws cloudformation describe-stacks \
  --stack-name "${PROJECT_NAME}-Dataplane" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?ExportName=='${PROJECT_NAME}-KeycloakUrl'].OutputValue | [0]" \
  --output text 2>/dev/null || true)

if [[ -z "${KEYCLOAK_URL}" || "${KEYCLOAK_URL}" == "None" ]]; then
  echo "ERROR: Could not resolve KeycloakUrl from stack ${PROJECT_NAME}-Dataplane."
  echo "       Ensure the stack is deployed."
  exit 1
fi
echo "    ${KEYCLOAK_URL}"

echo "==> Checking Keycloak is reachable..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${KEYCLOAK_URL}" || true)
# Match integration test: auth-server.integration.test.ts expects [200, 301, 302, 303]
if [[ "${HTTP_STATUS}" != "200" && "${HTTP_STATUS}" != "301" && "${HTTP_STATUS}" != "302" && "${HTTP_STATUS}" != "303" ]]; then
  echo "ERROR: Keycloak at ${KEYCLOAK_URL} returned HTTP ${HTTP_STATUS}."
  echo "       Ensure the service is running and network access is available."
  exit 1
fi
echo "    OK (HTTP ${HTTP_STATUS})"

# ── Run tests ──────────────────────────────────────────────────────────────

echo ""
echo "==> Running integration tests..."
cd "${CDK_DIR}"
npx jest --selectProjects integration --no-coverage --verbose
