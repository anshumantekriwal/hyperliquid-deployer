#!/bin/bash
# Build and push Docker image to ECR

set -e

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Default values
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID:-}
ECR_REPOSITORY=${ECR_REPOSITORY:-hyperliquid-agent}
IMAGE_TAG=${IMAGE_TAG:-latest}

# Validate required variables
if [ -z "$AWS_ACCOUNT_ID" ]; then
    echo "❌ Error: AWS_ACCOUNT_ID not set"
    exit 1
fi

ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_URI="${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}"

echo "╔═══════════════════════════════════════════════════╗"
echo "║      Building Hyperliquid Agent Docker Image     ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""
echo "📦 Repository: ${ECR_REPOSITORY}"
echo "🏷️  Tag: ${IMAGE_TAG}"
echo "☁️  Registry: ${ECR_REGISTRY}"
echo ""

# Build Docker image (from project root)
# Must build for linux/amd64 platform for ECS Fargate compatibility
cd ..
echo "🔨 Building Docker image for linux/amd64 platform..."
docker build --platform linux/amd64 -f hyperliquid-deployer/Dockerfile -t ${ECR_REPOSITORY}:${IMAGE_TAG} .

# Tag for ECR
echo "🏷️  Tagging image for ECR..."
docker tag ${ECR_REPOSITORY}:${IMAGE_TAG} ${IMAGE_URI}

# Login to ECR
echo "🔐 Logging in to ECR..."
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}

# Create repository if it doesn't exist
echo "📦 Checking ECR repository..."
aws ecr describe-repositories --repository-names ${ECR_REPOSITORY} --region ${AWS_REGION} 2>/dev/null || \
    aws ecr create-repository --repository-name ${ECR_REPOSITORY} --region ${AWS_REGION}

# Push to ECR
echo "🚀 Pushing image to ECR..."
docker push ${IMAGE_URI}

echo ""
echo "✅ Image pushed successfully!"
echo "   ${IMAGE_URI}"
echo ""
