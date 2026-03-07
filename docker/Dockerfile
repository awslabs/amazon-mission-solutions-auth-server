# Copyright Amazon.com, Inc. or its affiliates.
ARG KEYCLOAK_VERSION=latest

# Stage 1: Install tools using Amazon Linux 2023
FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS tools

RUN dnf install -y unzip && \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && ./aws/install --install-dir /opt/aws-cli --bin-dir /opt/aws-bin && \
    rm -rf awscliv2.zip aws && \
    dnf clean all

# Stage 2: Build the Keycloak wrapper image
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}

USER root

# Copy AWS CLI from the AL2023 tools stage
COPY --from=tools /opt/aws-cli /opt/aws-cli
COPY --from=tools /opt/aws-bin /usr/local/bin

# Copy Infinispan cache config from its canonical CDK location (build context is repo root)
COPY cdk/lib/constructs/auth-server/cache-ispn-jdbc-ping.xml /opt/keycloak/conf/cache-ispn-jdbc-ping.xml

# Copy entrypoint wrapper
COPY docker/entrypoint.sh /opt/keycloak/entrypoint.sh
RUN chmod +x /opt/keycloak/entrypoint.sh

# Switch back to keycloak user
USER keycloak

ENTRYPOINT ["/opt/keycloak/entrypoint.sh"]
