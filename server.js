/**
 * Hyperliquid Agent Deployer
 *
 * Deploys long-lived trading agents to AWS ECS Fargate Services.
 */
import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  CreateServiceCommand,
  UpdateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand
} from '@aws-sdk/client-ecs';
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  PutRetentionPolicyCommand
} from '@aws-sdk/client-cloudwatch-logs';
// import { TEST_AGENT_CODE } from './test-code-dictionary.js';

dotenv.config();

const app = express();
app.use(express.json());

// ============================================================================
// CONFIGURATION
// ============================================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const ECS_CLUSTER = process.env.ECS_CLUSTER || 'hyperliquid-agents';
const ECR_REPOSITORY = process.env.ECR_REPOSITORY || 'hyperliquid-agent';
const ECR_REGISTRY = process.env.ECR_REGISTRY || `${process.env.AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com`;
const SUBNET_IDS = (process.env.SUBNET_IDS || '').split(',').filter(Boolean);
const SECURITY_GROUP_IDS = (process.env.SECURITY_GROUP_IDS || '').split(',').filter(Boolean);
const ASSIGN_PUBLIC_IP = process.env.ASSIGN_PUBLIC_IP === 'true';
const ECS_EXECUTION_ROLE_ARN = process.env.ECS_EXECUTION_ROLE_ARN; // required!
const ECS_TASK_ROLE_ARN = process.env.ECS_TASK_ROLE_ARN || null;    // optional

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://localhost:8000';

const ecsClient = new ECSClient({ region: AWS_REGION });
const logsClient = new CloudWatchLogsClient({ region: AWS_REGION });

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function generateAgentCode(strategyDescription, useTestCode = false) {
  // Use test code dictionary if flag is set (for testing without AI engine)
  useTestCode = false;
  
  console.log('🤖 Calling AI engine...');
  const response = await axios.post(`${AI_ENGINE_URL}/generate`, {
    strategy_description: strategyDescription
  });
  if (!response.data.success) throw new Error(response.data.error || 'Code generation failed');
  return {
    initialization_code: response.data.initialization_code,
    trigger_code: response.data.trigger_code,
    execution_code: response.data.execution_code
  };
}

async function createAgentRecord(agentData) {
  
  const { data, error } = await supabase
    .from('agents')
    .insert({
      user_id: agentData.userId,
      agent_name: agentData.agentName,
      strategy_description: agentData.strategyDescription,
      initialization_code: agentData.initialization_code,
      trigger_code: agentData.trigger_code,
      execution_code: agentData.execution_code,
      status: 'deploying',
      instruction: 'RUN',
      agent_deployed: false,
      hyperliquid_address: agentData.hyperliquidAddress,
      deployment: {
        ecr_repository: ECR_REPOSITORY,
        ecs_cluster: ECS_CLUSTER
      }
    })
    .select()
    .single();

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  console.log(`✅ Agent created: ${data.id}`);
  return data;
}

async function ensureLogGroup(agentId) {
  const logGroupName = `/ecs/hyperliquid-agents/${agentId}`;
  try {
    await logsClient.send(new CreateLogGroupCommand({ logGroupName }));
  } catch (err) {
    if (err.name !== 'ResourceAlreadyExistsException') throw err;
  }
  try {
    await logsClient.send(new PutRetentionPolicyCommand({
      logGroupName,
      retentionInDays: 30
    }));
  } catch (err) {
    console.warn(`Retention policy failed: ${err.message}`);
  }
  return logGroupName;
}

async function deployToFargate(agentId, credentials) {
  console.log(`🚀 Deploying service for agent ${agentId}`);

  // Validate required AWS configuration
  if (!SUBNET_IDS || SUBNET_IDS.length === 0) {
    throw new Error('SUBNET_IDS environment variable is required');
  }
  if (!SECURITY_GROUP_IDS || SECURITY_GROUP_IDS.length === 0) {
    throw new Error('SECURITY_GROUP_IDS environment variable is required');
  }
  if (!ECS_EXECUTION_ROLE_ARN) {
    throw new Error('ECS_EXECUTION_ROLE_ARN environment variable is required');
  }

  const logGroupName = await ensureLogGroup(agentId);
  const imageUri = `${ECR_REGISTRY}/${ECR_REPOSITORY}:latest`;

  const environment = [
    { name: 'AGENT_ID', value: agentId },
    { name: 'HYPERLIQUID_PRIVATE_KEY', value: credentials.apiKey },
    { name: 'HYPERLIQUID_ADDRESS', value: credentials.hyperliquidAddress },
    { name: 'SUPABASE_URL', value: process.env.SUPABASE_URL },
    { name: 'SUPABASE_ANON_KEY', value: process.env.SUPABASE_ANON_KEY },
    { name: 'AWS_REGION', value: AWS_REGION },
    { name: 'LOG_GROUP_NAME', value: logGroupName },
    // Add more shared or per-agent vars here
  ];

  const taskFamily = `hyperliquid-agent-${agentId}`;

  // Register task definition
  const taskDefResp = await ecsClient.send(new RegisterTaskDefinitionCommand({
    family: taskFamily,
    requiresCompatibilities: ['FARGATE'],
    networkMode: 'awsvpc',
    cpu: '512',
    memory: '1024',
    executionRoleArn: ECS_EXECUTION_ROLE_ARN,
    taskRoleArn: ECS_TASK_ROLE_ARN,
    containerDefinitions: [{
      name: 'agent',
      image: imageUri,
      essential: true,
      environment,
      // Command to run agentRunner.js with AGENT_ID from environment variable
      command: ['sh', '-c', 'node agentRunner.js $AGENT_ID'],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': logGroupName,
          'awslogs-region': AWS_REGION,
          'awslogs-stream-prefix': 'agent',
          'awslogs-create-group': 'true'
        }
      },
      healthCheck: {
        command: ['CMD-SHELL', 'pgrep -f "node agentRunner.js" || exit 1'],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 120
      }
    }]
  }));

  const taskDefArn = taskDefResp.taskDefinition.taskDefinitionArn;

  const serviceName = `agent-svc-${agentId}`;

  // Helper function to create a new service
  async function createNewService() {
    const createResp = await ecsClient.send(new CreateServiceCommand({
      cluster: ECS_CLUSTER,
      serviceName,
      taskDefinition: taskDefArn,
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNET_IDS,
          securityGroups: SECURITY_GROUP_IDS,
          assignPublicIp: ASSIGN_PUBLIC_IP ? 'ENABLED' : 'DISABLED'
        }
      },
      deploymentConfiguration: {
        maximumPercent: 200,
        minimumHealthyPercent: 100
      },
    }));
    return createResp.service.serviceArn;
  }

  // Check if service already exists
  let serviceArn;
  try {
    const desc = await ecsClient.send(new DescribeServicesCommand({
      cluster: ECS_CLUSTER,
      services: [serviceName]
    }));

    if (desc.services && desc.services.length > 0) {
      const existingService = desc.services[0];
      // If service exists, try to update it regardless of status
      // This handles cases where service is INACTIVE, DRAINING, etc.
      try {
        const updateResp = await ecsClient.send(new UpdateServiceCommand({
          cluster: ECS_CLUSTER,
          service: serviceName,
          taskDefinition: taskDefArn,
          forceNewDeployment: true,
          desiredCount: 1,
          deploymentConfiguration: {
            maximumPercent: 200,
            minimumHealthyPercent: 100
          }
        }));
        serviceArn = updateResp.service.serviceArn;
        console.log(`✅ Service updated: ${serviceArn} (previous status: ${existingService.status})`);
      } catch (updateErr) {
        // If update fails (e.g., service is INACTIVE), delete and recreate
        console.warn(`Failed to update service (${existingService.status}), deleting and recreating: ${updateErr.message}`);
        try {
          // Delete the existing service
          await ecsClient.send(new DeleteServiceCommand({
            cluster: ECS_CLUSTER,
            service: serviceName,
            force: true
          }));
          console.log(`🗑️  Deleted inactive service: ${serviceName}`);
          // Wait a moment for deletion to propagate
          await new Promise(resolve => setTimeout(resolve, 2000));
          // Create new service
          serviceArn = await createNewService();
          console.log(`✅ Service recreated: ${serviceArn}`);
        } catch (deleteErr) {
          throw new Error(`Failed to update or delete service: ${updateErr.message}. Delete attempt: ${deleteErr.message}`);
        }
      }
    } else {
      // Service doesn't exist, create it
      serviceArn = await createNewService();
      console.log(`✅ Service created: ${serviceArn}`);
    }
  } catch (err) {
    // If DescribeServices fails (service doesn't exist), create it
    if (err.name === 'ServiceNotFoundException' || err.message?.includes('not found')) {
      try {
        serviceArn = await createNewService();
        console.log(`✅ Service created: ${serviceArn}`);
      } catch (createErr) {
        throw new Error(`Failed to create service: ${createErr.message}`);
      }
    } else {
      throw new Error(`Failed to check service status: ${err.message}`);
    }
  }

  return {
    serviceArn,
    taskDefArn,
    logGroupName,
    logUrl: `https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#logsV2:log-groups/log-group/${encodeURIComponent(logGroupName)}`
  };
}

async function updateAgentDeployment(agentId, deploymentDetails) {
  const { error } = await supabase
    .from('agents')
    .update({
      status: 'running',
      agent_deployed: true,
      deployment: {
        service_arn: deploymentDetails.serviceArn,
        task_definition_arn: deploymentDetails.taskDefArn,
        log_group: deploymentDetails.logGroupName,
        log_url: deploymentDetails.logUrl,
        deployed_at: new Date().toISOString()
      },
      updated_at: new Date().toISOString()
    })
    .eq('id', agentId);

  if (error) throw new Error(`Update failed: ${error.message}`);
  console.log('Agent record updated with deployment info');
}

// ============================================================================
// ENDPOINTS
// ============================================================================

app.post('/deploy', async (req, res) => {
  try {
    const {
      userId,
      agentName,
      strategyDescription,
      hyperliquidAddress,
      apiKey,
      isMainnet = true,
      maxPositionSize,
      maxLeverage,
      dailyLossLimit,
      useTestCode = false  // Use test code dictionary instead of AI engine
    } = req.body;

    if (!userId || !agentName || !strategyDescription || !hyperliquidAddress || !apiKey) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const code = await generateAgentCode(strategyDescription, useTestCode);
    const agent = await createAgentRecord({
      userId,
      agentName,
      strategyDescription,
      hyperliquidAddress,
      initialization_code: code.initialization_code,
      trigger_code: code.trigger_code,
      execution_code: code.execution_code,
      isMainnet,
      maxPositionSize,
      maxLeverage,
      dailyLossLimit
    });

    let deployment;
    try {
      deployment = await deployToFargate(agent.id, { apiKey, hyperliquidAddress });
      await updateAgentDeployment(agent.id, deployment);
    } catch (deployError) {
      // Update agent status to error on deployment failure
      console.error(`Deployment failed for agent ${agent.id}:`, deployError);
      try {
        const { error: updateError } = await supabase
          .from('agents')
          .update({
            status: 'error',
            updated_at: new Date().toISOString()
          })
          .eq('id', agent.id);
        
        if (updateError) {
          console.error('Failed to update agent status:', updateError);
        }
      } catch (statusUpdateErr) {
        console.error('Error updating agent status:', statusUpdateErr);
      }
      
      throw deployError;
    }

    res.json({
      success: true,
      agentId: agent.id,
      serviceArn: deployment.serviceArn,
      taskDefArn: deployment.taskDefArn,
      logUrl: deployment.logUrl,
      status: 'running'
    });
  } catch (error) {
    console.error('Deployment failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/status', (req, res) => {
  res.json({ status: 'running', service: 'hyperliquid-deployer' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Hyperliquid Agent Deployer running on port ${PORT}`);
});