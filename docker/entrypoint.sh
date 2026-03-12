#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates.

set -euo pipefail

SSM_PREFIX="${SSM_PREFIX:-/keycloak/auth}"
AWS_REGION="${AWS_REGION:-us-east-1}"
DB_WAIT_TIMEOUT="${DB_WAIT_TIMEOUT:-300}"
DB_WAIT_INTERVAL="${DB_WAIT_INTERVAL:-5}"

echo "Reading database configuration from SSM..."

# Read SSM parameters (retry loop for eventual consistency during first deploy)
MAX_SSM_RETRIES=60
SSM_RETRY_INTERVAL=5
for i in $(seq 1 $MAX_SSM_RETRIES); do
  DB_HOST=$(aws ssm get-parameter --name "${SSM_PREFIX}/database/endpoint" \
    --region "$AWS_REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "")
  DB_PORT=$(aws ssm get-parameter --name "${SSM_PREFIX}/database/port" \
    --region "$AWS_REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "")

  if [ -n "$DB_HOST" ] && [ -n "$DB_PORT" ]; then
    echo "SSM parameters retrieved: host=$DB_HOST, port=$DB_PORT"
    break
  fi

  echo "SSM parameters not yet available (attempt $i/$MAX_SSM_RETRIES), waiting ${SSM_RETRY_INTERVAL}s..."
  sleep $SSM_RETRY_INTERVAL
done

if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ]; then
  echo "ERROR: Failed to read SSM parameters after $MAX_SSM_RETRIES attempts"
  exit 1
fi

# Export for Keycloak and Infinispan
export KC_DB_URL_HOST="$DB_HOST"
export KC_DB_URL_PORT="$DB_PORT"

echo "Waiting for database cluster to be available..."
# Extract cluster identifier from the endpoint hostname (first segment before '.')
DB_CLUSTER_ID=$(echo "$DB_HOST" | cut -d'.' -f1)
echo "Using cluster identifier: $DB_CLUSTER_ID"

# First attempt — log any errors to help diagnose IAM/naming issues
DB_STATUS=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$DB_CLUSTER_ID" \
  --region "$AWS_REGION" \
  --query 'DBClusters[0].Status' \
  --output text 2>&1) || true
echo "Initial DB status check result: $DB_STATUS"

# Poll until available
ELAPSED=0
while true; do
  DB_STATUS=$(aws rds describe-db-clusters \
    --db-cluster-identifier "$DB_CLUSTER_ID" \
    --region "$AWS_REGION" \
    --query 'DBClusters[0].Status' \
    --output text 2>/dev/null || echo "unknown")

  if [ "$DB_STATUS" = "available" ]; then
    echo "Database cluster is available."
    break
  fi

  if [ $ELAPSED -ge $DB_WAIT_TIMEOUT ]; then
    echo "ERROR: Database not available after ${DB_WAIT_TIMEOUT}s (status: $DB_STATUS)"
    # Log the full error for debugging
    aws rds describe-db-clusters \
      --db-cluster-identifier "$DB_CLUSTER_ID" \
      --region "$AWS_REGION" 2>&1 || true
    exit 1
  fi

  echo "Database status: $DB_STATUS (attempt at ${ELAPSED}s/${DB_WAIT_TIMEOUT}s), waiting ${DB_WAIT_INTERVAL}s..."
  sleep $DB_WAIT_INTERVAL
  ELAPSED=$((ELAPSED + DB_WAIT_INTERVAL))
done

# Build and start Keycloak
echo "Running kc.sh build..."
/opt/keycloak/bin/kc.sh build

echo "Starting Keycloak..."
exec /opt/keycloak/bin/kc.sh start "$@"
