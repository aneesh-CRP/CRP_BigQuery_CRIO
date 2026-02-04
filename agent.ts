import { LlmAgent, AgentTool } from '@google/adk';
import dotenv from 'dotenv';
import { createSqlAgent } from './agents/sql_agent.ts';

dotenv.config();

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
    name: 'clinical_research_orchestrator',
    model: 'gemini-2.5-flash',
    description: 'An AI agent that answers questions about clinical research data by delegating to a specialist.',
    instruction: `You are the Lead Clinical Research Analyst.
  Your goal is to answer user questions comprehensively.
  You have a specialist sub-agent named **bigquery_sql_specialist**.
  
  ### Workflow
  1. **Understand**: Analyze the user's request.
  2. **Delegate**: Pass the data-retrieval task to the \`bigquery_sql_specialist\`. 
     - Ask the specialist to find the relevant data.
     - You can give high-level instructions like "Find the number of patients in each study."
  3. **Synthesize**: Once the specialist returns the data, interpret it and formulate the final answer for the user.
  4. **Iterate**: If the specialist fails or needs more direction, provide more specific instructions.
  
  Always use the \`bigquery_sql_specialist\` for any database interaction.`,
    tools: [sqlAgentTool],
    beforeModelCallback: (params) => {
      console.log("\n[RootAgent] --> 🤔 Thinking (Sending request to model)...");
      return undefined;
    },
    afterModelCallback: (params) => {
      console.log("\n[RootAgent] <-- 💡 Output received (Callback Triggered):");

      try {
        const safeParams = {
          ...params,
          context: 'OMITTED', // Context is huge and circular
          agent: 'OMITTED'
        };
        console.log(`[RootAgent] RAW PARAMS KEYS: ${Object.keys(params).join(', ')}`);
        // console.log(`[RootAgent] FULL PARAMS: ${JSON.stringify(safeParams, null, 2)}`);
      } catch (e) {
        console.error("Error logging params:", e);
      }

      // Check if there's an error in params
      if ((params as any).error) {
        console.error("error in callback params:", (params as any).error);
      }

      const response = params.response as any;
      if (response) {
        console.log(`[RootAgent] RAW RESPONSE STRUCTURE: ${JSON.stringify(response, null, 2)}`);
        if (response.candidates && response.candidates[0].content.parts) {
          response.candidates[0].content.parts.forEach((part: any) => {
            if (part.text) {
              console.log(`[RootAgent] 🗣️  Text: ${part.text}`);
            }
            if (part.functionCall) {
              console.log(`[RootAgent] 🛠️  Tool Call: ${part.functionCall.name}(${JSON.stringify(part.functionCall.args)})`);
            }
          });
        } else {
          console.log("[RootAgent] Response exists but no candidates/parts found via standard path.");
        }
      } else {
        console.log("[RootAgent] No response object in params.");
      }
      return undefined;
    }
  });

  return { agent, setLogHandler: (handler: (msg: string) => void) => { logHandler = handler; } };
};

// Default instance for CLI/DevTools usage (no auth token)
export const rootAgent = createRootAgent();