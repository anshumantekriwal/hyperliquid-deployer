# Dockerfile for Hyperliquid Agent Container
# Build from project root: docker build --platform linux/amd64 -f hyperliquid-deployer/Dockerfile -t hyperliquid-agent .
# This image will be pushed to ECR and used by Fargate tasks
# Note: Must build for linux/amd64 platform for ECS Fargate compatibility

FROM --platform=linux/amd64 node:22-alpine

WORKDIR /app

# Copy package files
COPY hyperliquid/package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy agent code
COPY hyperliquid/ ./

# Create entrypoint script - using multiple echo commands for reliability
RUN { \
    echo '#!/bin/sh'; \
    echo 'set -e'; \
    echo 'if [ -z "$AGENT_ID" ]; then'; \
    echo '  echo "Error: AGENT_ID environment variable is not set"'; \
    echo '  exit 1'; \
    echo 'fi'; \
    echo 'exec node agentRunner.js "$AGENT_ID"'; \
} > /app/entrypoint.sh && \
    chmod +x /app/entrypoint.sh && \
    ls -la /app/entrypoint.sh && \
    head -5 /app/entrypoint.sh

# Use entrypoint script
ENTRYPOINT ["/app/entrypoint.sh"]

# Default environment variables (can be overridden by Fargate)
ENV NODE_ENV=production
