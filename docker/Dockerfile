# Copyright Amazon.com, Inc. or its affiliates.
#
# Keycloak on Amazon Linux 2023 (minimal)
#
# Builds a Keycloak server image using AL2023-minimal + Amazon Corretto 21.
# The Dockerfile can resolve "latest" and download the tarball on its own,
# or use a pre-downloaded keycloak-<ver>.tar.gz from docker/ if present.
#
# Usage:
#   docker build -f docker/Dockerfile .
#   docker build --build-arg KEYCLOAK_VERSION=26.0.7 -f docker/Dockerfile .
#   docker build --build-arg BASE_IMAGE=<ecr>/amazonlinux:2023-minimal ...
#
# For standalone builds with dual-tagging, use docker/build.sh instead.
# Build context must be the repository root.
#

ARG BASE_IMAGE=public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ARG KEYCLOAK_VERSION=latest

# -------------------------------------------------------------------
# Stage 1: Build — install AWS CLI and obtain Keycloak distribution
# -------------------------------------------------------------------
FROM ${BASE_IMAGE} AS builder

ARG KEYCLOAK_VERSION
WORKDIR /build

RUN dnf install -y unzip tar gzip && \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" \
      -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install --install-dir /opt/aws-cli --bin-dir /opt/aws-bin && \
    rm -rf awscliv2.zip aws && \
    dnf clean all

# Copy any pre-downloaded keycloak-<ver>.tar.gz from docker/.
# The glob bracket trick makes COPY a no-op when no files match.
COPY docker/keycloak-*.tar.g[z] /build/local/

# Resolve version if "latest", check for cached tarball, download if needed.
RUN KC_VER="${KEYCLOAK_VERSION}"; \
    if [ "${KC_VER}" = "latest" ]; then \
      echo "Resolving latest Keycloak version from GitHub..." && \
      API_RESPONSE=$(curl -fsSL \
        "https://api.github.com/repos/keycloak/keycloak/releases/latest") && \
      KC_VER=$(echo "${API_RESPONSE}" \
        | grep -m1 '"tag_name"' \
        | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/'); \
      if [ -z "${KC_VER}" ]; then \
        echo "ERROR: Failed to resolve latest version from GitHub API" >&2; \
        exit 1; \
      fi; \
      echo "Resolved: ${KC_VER}"; \
    fi; \
    if [ -f "/build/local/keycloak-${KC_VER}.tar.gz" ]; then \
      echo "Using cached tarball: keycloak-${KC_VER}.tar.gz"; \
      mv "/build/local/keycloak-${KC_VER}.tar.gz" /build/keycloak.tar.gz; \
    else \
      echo "Fetching Keycloak ${KC_VER} from GitHub..."; \
      TARBALL_URL="https://github.com/keycloak/keycloak/releases/download/${KC_VER}/keycloak-${KC_VER}.tar.gz"; \
      if ! curl -fsSL -o /build/keycloak.tar.gz "${TARBALL_URL}"; then \
        echo "ERROR: Keycloak version '${KC_VER}' not found on GitHub." >&2; \
        echo "Check available versions at: https://github.com/keycloak/keycloak/releases" >&2; \
        exit 1; \
      fi; \
    fi && \
    mkdir -p /build/keycloak && \
    tar -xzf /build/keycloak.tar.gz -C /build/keycloak \
      --strip-components=1 && \
    rm -rf /build/keycloak.tar.gz /build/local

# -------------------------------------------------------------------
# Stage 2: Final runtime image
# -------------------------------------------------------------------
FROM ${BASE_IMAGE}

ARG KEYCLOAK_VERSION

LABEL maintainer="Amazon Mission Solutions"
LABEL keycloak.version="${KEYCLOAK_VERSION}"

RUN dnf install -y \
      java-21-amazon-corretto-headless \
      hostname \
      shadow-utils && \
    dnf clean all

RUN groupadd -r keycloak && \
    useradd -r -g keycloak -d /opt/keycloak -s /sbin/nologin keycloak

COPY --from=builder /build/keycloak /opt/keycloak
RUN mkdir -p /opt/keycloak/data && \
    chown -R keycloak:keycloak /opt/keycloak

COPY --from=builder /opt/aws-cli /opt/aws-cli
COPY --from=builder /opt/aws-bin /usr/local/bin

COPY cdk/lib/constructs/auth-server/cache-ispn-jdbc-ping.xml \
     /opt/keycloak/conf/cache-ispn-jdbc-ping.xml

COPY docker/entrypoint.sh /opt/keycloak/entrypoint.sh
RUN chmod +x /opt/keycloak/entrypoint.sh && \
    chown keycloak:keycloak \
      /opt/keycloak/entrypoint.sh \
      /opt/keycloak/conf/cache-ispn-jdbc-ping.xml

USER keycloak

ENV KC_HOME=/opt/keycloak
ENV PATH="${KC_HOME}/bin:${PATH}"

ENTRYPOINT ["/opt/keycloak/entrypoint.sh"]
