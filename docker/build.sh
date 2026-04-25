#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates.
#
# Build the Keycloak AL2023 Docker image.
#
# Resolves the Keycloak version, downloads the tarball if not cached,
# and builds the Docker image with both version and latest tags.
#
# Usage (run from repo root):
#   ./docker/build.sh
#   ./docker/build.sh --version 26.0.7
#   ./docker/build.sh --tag 123456.dkr.ecr.us-east-1.amazonaws.com/ams-keycloak
#   ./docker/build.sh --base-image <internal-ecr>/amazonlinux:2023
#

set -euo pipefail

SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

KEYCLOAK_VERSION="${KEYCLOAK_VERSION:-latest}"
IMAGE_NAME=""
BASE_IMAGE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --tag)        IMAGE_NAME="$2"; shift 2 ;;
    --version)    KEYCLOAK_VERSION="$2"; shift 2 ;;
    --base-image) BASE_IMAGE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo "  --tag <name>         Image name without tag (default: ams-keycloak)"
      echo "  --version <ver>      Keycloak version (default: latest)"
      echo "  --base-image <uri>   Override AL2023 base image"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

IMAGE_NAME="${IMAGE_NAME:-ams-keycloak}"

# --- Resolve version and get tarball digest from GitHub ---
if [ "${KEYCLOAK_VERSION}" = "latest" ]; then
  RELEASE_URL="https://api.github.com/repos/keycloak/keycloak/releases/latest"
  echo "Resolving latest Keycloak version from GitHub..."
else
  RELEASE_URL="https://api.github.com/repos/keycloak/keycloak/releases/tags/${KEYCLOAK_VERSION}"
fi

API_RESPONSE=$(curl -fsSL "${RELEASE_URL}")

if [ "${KEYCLOAK_VERSION}" = "latest" ]; then
  KEYCLOAK_VERSION=$(echo "${API_RESPONSE}" \
    | grep -m1 '"tag_name"' \
    | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
  if [ -z "${KEYCLOAK_VERSION}" ]; then
    echo "ERROR: Failed to resolve latest version from GitHub API" >&2
    exit 1
  fi
  echo "Resolved: ${KEYCLOAK_VERSION}"
fi

TARBALL_NAME="keycloak-${KEYCLOAK_VERSION}.tar.gz"
EXPECTED_DIGEST=$(echo "${API_RESPONSE}" \
  | jq -r --arg name "${TARBALL_NAME}" \
      '.assets[] | select(.name == $name) | .digest | sub("^sha256:"; "")')
if [ -z "${EXPECTED_DIGEST}" ]; then
  echo "ERROR: Could not find sha256 digest for ${TARBALL_NAME} in GitHub release metadata" >&2
  exit 1
fi
echo "Expected SHA256: ${EXPECTED_DIGEST}"

# --- Download tarball ---
TARBALL="${REPO_ROOT}/docker/${TARBALL_NAME}"
trap 'rm -f "${TARBALL}"' EXIT
TARBALL_URL="https://github.com/keycloak/keycloak/releases/download/${KEYCLOAK_VERSION}/keycloak-${KEYCLOAK_VERSION}.tar.gz"
echo "Downloading Keycloak ${KEYCLOAK_VERSION}..."
HTTP_CODE=$(curl -fsSL -o "${TARBALL}" -w "%{http_code}" "${TARBALL_URL}" 2>/dev/null) || true
if [ ! -f "${TARBALL}" ] || [ "$(stat -c%s "${TARBALL}" 2>/dev/null || echo 0)" -lt 1000 ]; then
  echo "ERROR: Keycloak version '${KEYCLOAK_VERSION}' not found on GitHub (HTTP ${HTTP_CODE})." >&2
  echo "Check available versions at: https://github.com/keycloak/keycloak/releases" >&2
  exit 1
fi

# --- Verify tarball integrity ---
ACTUAL_DIGEST=$(sha256sum "${TARBALL}" | awk '{print $1}')
if [ "${ACTUAL_DIGEST}" != "${EXPECTED_DIGEST}" ]; then
  rm -f "${TARBALL}"
  echo "ERROR: SHA256 mismatch for ${TARBALL}" >&2
  echo "  expected: ${EXPECTED_DIGEST}" >&2
  echo "  actual:   ${ACTUAL_DIGEST}" >&2
  exit 1
fi
echo "SHA256 verified: ${ACTUAL_DIGEST}"

# --- Build image ---
BUILD_ARGS=(
  --build-arg "KEYCLOAK_VERSION=${KEYCLOAK_VERSION}"
  -f "docker/Dockerfile"
  -t "${IMAGE_NAME}:${KEYCLOAK_VERSION}"
  -t "${IMAGE_NAME}:latest"
)

if [ -n "${BASE_IMAGE}" ]; then
  BUILD_ARGS+=(--build-arg "BASE_IMAGE=${BASE_IMAGE}")
fi

echo "Building image: ${IMAGE_NAME}"
echo "  Keycloak version: ${KEYCLOAK_VERSION}"
echo "  Tags: ${IMAGE_NAME}:${KEYCLOAK_VERSION}, ${IMAGE_NAME}:latest"

docker build "${BUILD_ARGS[@]}" "${REPO_ROOT}"

echo "Done. Tagged as:"
echo "  ${IMAGE_NAME}:${KEYCLOAK_VERSION}"
echo "  ${IMAGE_NAME}:latest"
