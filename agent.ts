import { LlmAgent, AgentTool } from '@google/adk';
import dotenv from 'dotenv';
import { createSqlAgent } from './agents/sql_agent.ts';
import { logger } from './lib/logger.ts';
// @ts-ignore
import config from './config.json' with { type: "json" };

dotenv.config();

const { orchestrator } = config.agent;

export const createRootAgent = (authToken?: string) => {
  let logHandler: ((msg: string) => void) | undefined;

  const onLog = (msg: string) => {
    if (logHandler) logHandler(msg);
  };

  const sqlAgent = createSqlAgent(authToken, onLog);

  const sqlAgentTool = new AgentTool({
    agent: sqlAgent,
  });

  const agent = new LlmAgent({
    name: orchestrator.name,
    model: config.agent.model,
    description: `An AI agent that answers questions about ${orchestrator.domain} by delegating to a specialist.`,
    instruction: `You are the ${orchestrator.role}.
Your goal is to answer user questions comprehensively.
You have a ${orchestrator.specialistDescription} named **${config.agent.sqlSpecialist.name}**.

### Workflow
1. **Analyze**: Read the user's request.
2. **Reason**: Improved transparency. Briefly think out loud about *which* tables might be relevant and *why* you are choosing a specific tool.
3. **Delegate**: Pass the data-retrieval task to the \`${config.agent.sqlSpecialist.name}\`. 
   - Ask the specialist to find the relevant data.
   - You can give high-level instructions like "Find the number of records grouped by category."
4. **Synthesize**: Once the specialist returns the data, interpret it and formulate the final answer for the user.
5. **Iterate**: If the specialist fails or needs more direction, provide more specific instructions.

Always use the \`${config.agent.sqlSpecialist.name}\` for any database interaction.`,
    tools: [sqlAgentTool],
    beforeModelCallback: (params) => {
      logger.debug('[RootAgent] Sending request to model');
      return undefined;
    },
    afterModelCallback: (params) => {
      if ((params as any).error) {
        logger.error({ err: (params as any).error }, '[RootAgent] Error in callback params');
      }

      const response = params.response as any;
      const candidate = response?.candidates?.[0];
      const parts = candidate?.content?.parts;
      if (parts) {
        for (const part of parts) {
          if (part.text) {
            logger.debug({ text: part.text.slice(0, 200) }, '[RootAgent] Text response');
          }
          if (part.functionCall) {
            logger.debug({ tool: part.functionCall.name }, '[RootAgent] Tool call');
          }
        }
      } else if (response) {
        logger.warn({
          finishReason: candidate?.finishReason,
          safetyRatings: candidate?.safetyRatings,
          candidateCount: response?.candidates?.length,
          promptFeedback: response?.promptFeedback,
        }, '[RootAgent] Response exists but no candidates/parts found');
      } else {
        logger.debug('[RootAgent] No response object in params');
      }
      return undefined;
    }
  });

  return { agent, setLogHandler: (handler: (msg: string) => void) => { logHandler = handler; } };
};

// Default instance for CLI/DevTools usage (no auth token)
export const rootAgent = createRootAgent();