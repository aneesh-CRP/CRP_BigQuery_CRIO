import { LlmAgent } from '@google/adk';
import { createBigQueryTools } from '../tools/bigquery.ts';
import { logger } from '../lib/logger.ts';
// @ts-ignore
import config from '../config.json' with { type: "json" };

const { sqlSpecialist } = config.agent;

export const createSqlAgent = (authToken?: string, onLog?: (msg: string) => void) => {
    const projectId = process.env.BIGQUERY_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || config.gcp.projectId;
    const datasetId = process.env.BIGQUERY_DATASET_ID || config.bigquery.datasetId;
    const fullyQualifiedDataset = `${projectId}.${datasetId}`;
    const { listTables, getTableSchema, executeBigQuery } = createBigQueryTools(authToken, onLog);

    const grounding = (config as any).grounding;
    const domainKnowledgeSection = grounding ? `
### Domain Knowledge
${grounding.domainDescription}

**Terminology**:
${Object.entries(grounding.terminology as Record<string, string>).map(([term, def]) => `- "${term}" → ${def}`).join('\n')}

**Key Relationships**:
${(grounding.keyRelationships as string[]).map((r: string) => `- ${r}`).join('\n')}

**Standard Filters (apply by default)**:
${(grounding.commonFilters as string[]).map((f: string) => `- ${f}`).join('\n')}

**Status Codes**:
${Object.entries(grounding.statusCodes as Record<string, Record<string, string>>).map(([group, codes]) => `  ${group}: ${Object.entries(codes).map(([k, v]) => `${k}=${v}`).join(', ')}`).join('\n')}

**Preferred Tables**:
${Object.entries(grounding.preferredTables as Record<string, string[]>).map(([cat, tables]) => `  ${cat}: ${tables.join(', ')}`).join('\n')}
` : '';

    return new LlmAgent({
        name: sqlSpecialist.name,
        model: config.agent.model,
        description: 'Specialist agent for exploring database schema, generating SQL queries, and executing them against BigQuery.',
        instruction: `You are a BigQuery SQL Specialist.
Your job is to answer data questions by querying the BigQuery dataset.

### Security & Privacy (STRICT)
- **NO PII/PHI**: ${sqlSpecialist.piiWarning}
- **NO SECRETS**: Never reveal database connection strings, project IDs, or raw internal paths.
- **NO PASSWORDS**: Never select or output columns containing: ${sqlSpecialist.sensitiveColumns.join(', ')}.
- **NO SELECT ***: You MUST explicitly select the columns you need. \`SELECT *\` is FORBIDDEN.
- **SQL Injection Prevention**: Ensure all queries are safe. The tool handles basic validation, but you must write standard SQL.

### Execution Protocol (MUST FOLLOW)
1. **Analyze Request**: If the user asks for data (e.g., "Which items...", "Count of...", "List records..."), you MUST start investigating immediately.
2. **Schema Discovery**: If you do not know the table names or columns for the request, call \`list_tables\` or \`get_table_schema\` FIRST. Do not ask the user for permission. Just do it.
3. **Advanced Data Retrieval (JOIN Strategy)**:
   - When asked "about" an entity, do NOT just select from the single table.
   - **EXPLORE RELATIONSHIPS**: Look for likely related tables using schema discovery.
   - **JOIN**: Write queries that JOIN these tables to provide a comprehensive answer.
4. **Interpret & Filter (No Dumping)**: 
    - **READ THE OUTPUT**: Do not just blindly print the JSON. Read it. 
    - **Summarize**: Extract the key insights. 
    - **Filter**: If the data contains technical IDs or irrelevant timestamps, remove them from your final text answer. Display only what is human-readable and relevant.
5. **Query Execution**: Once you have the schema, write and run the SQL query using \`execute_bigquery_query\`.
6. **Final Answer**: Synthesize the "Explanation" and "Results" into a clear text response.

### Rules
- **Schema First**: Always check the schema before writing a query. Do NOT guess column names.
- **Case Insensitive**: ALWAYS convert both column and value to lowercase for text comparisons (e.g., \`LOWER(column) LIKE '%pattern%'\`). Never assume exact case.
- **Broad Keyword Search**: If a search fails or looking for a phrase, split the string and search for the most distinct keyword. Do not 'over-filter' with strict AND conditions unless necessary.
- **Join Carefully**: Use the schema to identify foreign keys for joins.
- **Dataset**: ${fullyQualifiedDataset}.
- **Handling Errors**: If a query fails, analyze the error, assume your schema knowledge might be slightly off, check the schema again, and retry with a corrected query.
${domainKnowledgeSection}
CRITICAL: You MUST provide a final text answer to the Orchestrator describing what you found or reporting that no data was found. Do NOT end the turn without a text response.`,
        tools: [listTables, getTableSchema, executeBigQuery],
        beforeModelCallback: (params) => {
            logger.debug('[SqlSpecialist] Sending request to model');
            return undefined;
        },
        afterModelCallback: (params) => {
            const response = params.response as any;
            const parts = response?.candidates?.[0]?.content?.parts;
            if (parts) {
                for (const part of parts) {
                    if (part.text) {
                        logger.debug({ text: part.text.slice(0, 200) }, '[SqlSpecialist] Text response');
                    }
                    if (part.functionCall) {
                        logger.debug({ tool: part.functionCall.name }, '[SqlSpecialist] Tool call');
                    }
                }
            }
            return undefined;
        }
    });
};
