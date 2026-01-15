# Hyperliquid Agent Deployer

Deployer service for Hyperliquid trading agents to AWS Fargate with Docker containers from ECR.

## Overview

This service handles the complete deployment workflow:
1. Receives deployment requests from the frontend
2. Calls AI engine to generate agent code
3. Creates agent record in Supabase
4. Deploys AWS Fargate task with agent container
5. Updates Supabase with deployment details and log URLs

## Architecture

- **One Docker image per agent** stored in AWS ECR
- **AWS Fargate** for running agent containers
- **CloudWatch Logs** for agent monitoring
- **Supabase** for agent metadata and state

## Prerequisites

- Node.js 20+
- AWS Account with:
  - ECS Cluster configured
  - ECR Repository created
  - Fargate task definition created
  - IAM roles with proper permissions
- Supabase project
- AI Engine service running

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `env.example` to `.env` and fill in your values:

```bash
cp env.example .env
```

Required environment variables:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_KEY` - Supabase service role key
- `AI_ENGINE_URL` - URL of the AI code generation service
- `AWS_REGION` - AWS region for deployment
- `AWS_ACCOUNT_ID` - Your AWS account ID
- `ECS_CLUSTER` - ECS cluster name
- `ECS_TASK_DEFINITION` - Fargate task definition name
- `ECR_REPOSITORY` - ECR repository name
- `SUBNET_IDS` - Comma-separated subnet IDs for Fargate tasks
- `SECURITY_GROUP_IDS` - Comma-separated security group IDs

Optional AWS credentials (if not using `~/.aws/credentials`):
- `AWS_ACCESS_KEY_ID` - AWS access key ID
- `AWS_SECRET_ACCESS_KEY` - AWS secret access key

**Note:** The deployer needs AWS credentials to access ECS, ECR, and CloudWatch Logs. You can provide them either:
1. Via `aws configure` (recommended for local development) - credentials stored in `~/.aws/credentials`
2. Via environment variables in `.env` file
3. Via IAM role (if running on AWS infrastructure like EC2/ECS/Lambda)

### 3. Configure AWS Credentials

If you haven't already configured AWS credentials:

```bash
# Option 1: Use AWS CLI (recommended)
aws configure
# Enter your AWS Access Key ID, Secret Access Key, and region

# Option 2: Add to .env file
# Add AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to your .env file
```

Verify credentials work:
```bash
aws sts get-caller-identity
aws ecs list-clusters --region us-east-1
```

### 4. Build and Push Docker Image to ECR

**Important:** ECS Fargate runs on `linux/amd64` architecture. If you're building on an ARM-based machine (e.g., Apple Silicon Mac), you must specify the platform:

```bash
# Use the build script (recommended - handles platform automatically)
./build.sh

# Or manually build for linux/amd64 platform
cd ..
docker build --platform linux/amd64 -f hyperliquid-deployer/Dockerfile -t hyperliquid-agent:latest .

# Tag for ECR
docker tag hyperliquid-agent:latest ${ECR_REGISTRY}/${ECR_REPOSITORY}:latest

# Login to ECR
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}

# Push to ECR
docker push ${ECR_REGISTRY}/${ECR_REPOSITORY}:latest
```

### 5. Create ECS Task Definition

Create a task definition in AWS ECS Console or via CLI:

```json
{
  "family": "hyperliquid-agent",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    {
      "name": "agent",
      "image": "${ECR_REGISTRY}/${ECR_REPOSITORY}:latest",
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/hyperliquid-agents",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "ecs",
          "awslogs-create-group": "true"
        }
      },
      "environment": []
    }
  ]
}
```

### 6. Start Deployer Service

```bash
npm start
```

## API Endpoints

### POST /deploy

Deploy a new agent.

**Request Body:**
```json
{
  "userId": "user_123",
  "agentName": "RSI Scalper",
  "strategyDescription": "Buy BTC when RSI < 30, sell when RSI > 70...",
  "hyperliquidAddress": "0x...",
  "apiKey": "private_key_here",
  "isMainnet": true,
  "maxPositionSize": 0.01,
  "maxLeverage": 5,
  "dailyLossLimit": 100
}
```

**Response:**
```json
{
  "success": true,
  "agentId": "uuid",
  "taskArn": "arn:aws:ecs:...",
  "taskId": "task-id",
  "logUrl": "https://console.aws.amazon.com/cloudwatch/...",
  "status": "running"
}
```

### GET /status

Health check endpoint.

**Response:**
```json
{
  "status": "running",
  "service": "hyperliquid-deployer",
  "version": "1.0.0"
}
```

## Deployment Workflow

1. **Frontend sends POST request** with agent details
2. **Deployer calls AI engine** `/generate` endpoint
3. **Agent record created** in Supabase with status `deploying`
4. **Fargate task launched** with agent container
5. **CloudWatch log group** created for agent
6. **Supabase updated** with deployment details and log URL

## Agent Container

The agent container runs `agentRunner.js` with the following environment variables:
- `AGENT_ID` - Agent UUID from Supabase
- `HYPERLIQUID_PRIVATE_KEY` - User's API key
- `HYPERLIQUID_ADDRESS` - User's Hyperliquid address
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key

## Monitoring

- **CloudWatch Logs**: Each agent has its own log group at `/ecs/hyperliquid-agents/{agentId}`
- **Log URL**: Provided in deployment response and stored in Supabase
- **Agent Status**: Tracked in Supabase `agents` table

## Error Handling

- If code generation fails, agent status is set to `failed`
- If Fargate deployment fails, agent status remains `deploying`
- All errors are logged and returned in API response

## AWS IAM Permissions Required

The deployer service needs the following IAM permissions. Create an IAM policy and attach it to your user/role:

### Minimal Required Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECSPermissions",
      "Effect": "Allow",
      "Action": [
        "ecs:CreateCluster",
        "ecs:DescribeClusters",
        "ecs:RunTask",
        "ecs:DescribeTasks",
        "ecs:ListTasks",
        "ecs:DescribeTaskDefinition"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IAMRoleManagement",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:GetRole",
        "iam:AttachRolePolicy",
        "iam:PutRolePolicy"
      ],
      "Resource": [
        "arn:aws:iam::*:role/ecsTaskExecutionRole",
        "arn:aws:iam::*:role/ecsTaskRole"
      ]
    },
    {
      "Sid": "ECSPassRole",
      "Effect": "Allow",
      "Action": [
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::*:role/ecsTaskExecutionRole",
        "arn:aws:iam::*:role/ecsTaskRole"
      ],
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "ecs-tasks.amazonaws.com"
        }
      }
    },
    {
      "Sid": "CloudWatchLogsPermissions",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:PutRetentionPolicy",
        "logs:DescribeLogGroups"
      ],
      "Resource": "arn:aws:logs:*:*:log-group:/ecs/hyperliquid-agents/*"
    },
    {
      "Sid": "EC2ReadPermissions",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeVpcs"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ECRPermissions",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:CreateRepository",
        "ecr:DescribeRepositories"
      ],
      "Resource": "*"
    }
  ]
}
```

### Required Permissions Breakdown

#### ECS Permissions
- **`ecs:CreateCluster`** - Create ECS cluster (if it doesn't exist)
- **`ecs:DescribeClusters`** - Check cluster status
- **`ecs:RunTask`** - Launch Fargate tasks
- **`ecs:DescribeTasks`** - Get task status/details
- **`ecs:ListTasks`** - List running tasks
- **`ecs:DescribeTaskDefinition`** - Verify task definition exists

#### IAM Role Management Permissions
- **`iam:CreateRole`** - Create task execution role (for setup)
- **`iam:GetRole`** - Check if role exists
- **`iam:AttachRolePolicy`** - Attach policies to roles
- **`iam:PutRolePolicy`** - Add inline policies to roles
- **`iam:PassRole`** - Required to pass the task execution role to ECS when running tasks
  - Must allow passing roles to `ecs-tasks.amazonaws.com` service

#### CloudWatch Logs Permissions
- **`logs:CreateLogGroup`** - Create log groups for each agent
- **`logs:PutRetentionPolicy`** - Set log retention (30 days)
- **`logs:DescribeLogGroups`** - Check if log group exists

#### EC2 Read Permissions
- **`ec2:DescribeSubnets`** - Verify subnet configuration
- **`ec2:DescribeSecurityGroups`** - Verify security group configuration
- **`ec2:DescribeVpcs`** - Verify VPC configuration

#### ECR Permissions (for building/pushing images)
- **`ecr:GetAuthorizationToken`** - Authenticate with ECR (required for docker login)
- **`ecr:BatchCheckLayerAvailability`** - Check if image layers exist
- **`ecr:GetDownloadUrlForLayer`** - Download image layers
- **`ecr:BatchGetImage`** - Pull images from ECR
- **`ecr:PutImage`** - Push images to ECR
- **`ecr:InitiateLayerUpload`** - Start uploading image layers
- **`ecr:UploadLayerPart`** - Upload image layer parts
- **`ecr:CompleteLayerUpload`** - Complete layer upload
- **`ecr:CreateRepository`** - Create ECR repository (if it doesn't exist)
- **`ecr:DescribeRepositories`** - List/describe ECR repositories

**Note:** ECR permissions are needed for the initial build/push process (`build.sh`). The deployer service itself doesn't directly interact with ECR, but your IAM user needs these permissions to push the Docker image.

### Creating the IAM Policy

1. **Via AWS Console:**
   - Go to IAM → Policies → Create Policy
   - Choose JSON tab
   - Paste the policy above (or use `iam-policy.json` file)
   - Name it: `HyperliquidDeployerPolicy`
   - Attach to your IAM user/role

2. **Via AWS CLI:**
   ```bash
   # Create policy from file
   aws iam create-policy \
     --policy-name HyperliquidDeployerPolicy \
     --policy-document file://iam-policy.json
   
   # Attach to user
   aws iam attach-user-policy \
     --user-name your-username \
     --policy-arn arn:aws:iam::YOUR_ACCOUNT_ID:policy/HyperliquidDeployerPolicy
   
   # Or attach to role (if running on EC2/ECS)
   aws iam attach-role-policy \
     --role-name your-role-name \
     --policy-arn arn:aws:iam::YOUR_ACCOUNT_ID:policy/HyperliquidDeployerPolicy
   ```

### Task Execution Role

**Important:** Your ECS Task Definition also needs a Task Execution Role with these permissions:
- `ecr:GetAuthorizationToken`
- `ecr:BatchCheckLayerAvailability`
- `ecr:GetDownloadUrlForLayer`
- `ecr:BatchGetImage`
- `logs:CreateLogStream`
- `logs:PutLogEvents`

This role is different from the deployer's role and is attached to the task definition.

**Creating Task Execution Role:**

```bash
# Create role
aws iam create-role \
  --role-name ecsTaskExecutionRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach policy (use task-execution-role-policy.json)
aws iam put-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-name EcsTaskExecutionRolePolicy \
  --policy-document file://task-execution-role-policy.json

# Or use AWS managed policy (simpler)
aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

**Note:** The AWS managed policy `AmazonECSTaskExecutionRolePolicy` includes all necessary permissions for ECR and CloudWatch Logs.

## Troubleshooting

### Agent fails to start
- Check CloudWatch logs for the agent
- Verify environment variables are set correctly
- Check ECS task definition matches container requirements

### Code generation fails
- Verify AI engine is running and accessible
- Check AI engine logs for errors
- Ensure strategy description is valid

### Fargate deployment fails
- Verify subnet IDs and security groups are correct
- Check IAM permissions for ECS and CloudWatch
- Ensure task definition exists and is compatible with Fargate

### ECR push fails (AccessDeniedException)
- Verify your IAM user has ECR permissions (`ecr:GetAuthorizationToken`, `ecr:PutImage`, etc.)
- Check that the IAM policy includes the ECR permissions section
- Ensure you're using the correct AWS credentials: `aws sts get-caller-identity`
- Try logging in manually: `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <registry>`

## Development

Run in development mode with auto-reload:

```bash
npm run dev
```

## License

MIT
