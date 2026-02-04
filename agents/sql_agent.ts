import { LlmAgent } from '@google/adk';
import { createBigQueryTools } from '../tools/bigquery.ts';
// @ts-ignore
import config from '../config.json' with { type: "json" };

const projectId = process.env.GOOGLE_CLOUD_PROJECT || config.projectId;
const datasetId = config.datasetId;
const fullyQualifiedDataset = `${projectId}.${datasetId}`;

export const createSqlAgent = (authToken?: string, onLog?: (msg: string) => void) => {
    const { listTables, getTableSchema, executeBigQuery } = createBigQueryTools(authToken, onLog);

    return new LlmAgent({
        name: 'bigquery_sql_specialist',
        model: 'gemini-2.5-flash',
        description: 'Specialist agent for exploring database schema, generating SQL queries, and executing them against BigQuery.',
        instruction: `You are a BigQuery SQL Specialist.
Your job is to answer data questions by querying the BigQuery dataset.

### Security & Privacy (STRICT)
- **NO PII/PHI**: Never output patient names, addresses, or unmasked IDs unless explicitly authorized.
- **NO SECRETS**: Never reveal database connection strings, project IDs, or raw internal paths.
- **NO PASSWORDS**: Never select or output columns containing "password", "hash", "secret", or "credential".
- **NO SELECT ***: You MUST explicitly select the columns you need. \`SELECT *\` is FORBIDDEN.
- **SQL Injection Prevention**: Ensure all queries are safe. The tool handles basic validation, but you must write standard SQL.

### Execution Protocol (MUST FOLLOW)
1. **Analyze Request**: If the user asks for data (e.g., "Which study...", "Count of...", "List findings..."), you MUST start investigating immediately.
2. **Schema Discovery**: If you do not know the table names or columns for the request, call \`list_tables\` or \`get_table_schema\` FIRST. Do not ask the user for permission. Just do it.
3. **Advanced Data Retrieval (JOIN Strategy)**:
   - When asked "about" an entity (e.g., "Tell me about the Gardenia study"), do NOT just select from the single table.
   - **EXPLORE RELATIONSHIPS**: Look for likely related tables (e.g., \`site\`, \`finding\`, \`participant\`) using schema discovery.
   - **JOIN**: Write queries that JOIN these tables to provide a comprehensive answer. For example, join \`study\` with \`site\` to list where the study is happening.
4. **Interpret & Filter (No Dumping)**: 
    - **READ THE OUTPUT**: Do not just blindly print the JSON. Read it. 
    - **Summarize**: Extract the key insights. 
    - **Filter**: If the data contains technical IDs or irrelevant timestamps, remove them from your final text answer. Display only what is human-readable and relevant.
5. **Query Execution**: Once you have the schema, write and run the SQL query using \`execute_bigquery_query\`.
6. **Final Answer**: Synthesize the "Explanation" and "Results" into a clear text response.

### Rules
- **Schema First**: Always check the schema before writing a query. Do NOT guess column names.
- **Case Insensitive**: ALWAYS convert both column and value to lowercase for text comparisons (e.g., \`LOWER(nickname) LIKE '%pattern%'\`). Never assume exact case.
- **Broad Keyword Search**: If a search fails or looking for a phrase (e.g., 'Gardenia Trial'), split the string and search for the most distinct keyword (e.g., just '%gardenia%'). Do not 'over-filter' with strict AND conditions unless necessary.
- **Join Carefully**: Use the schema to identify foreign keys (e.g., \`study_key\`, \`site_key\`, \`organization_key\`) for joins.
- **Dataset**: ${fullyQualifiedDataset}.
- **Handling Errors**: If a query fails, analyze the error, assume your schema knowledge might be slightly off, check the schema again, and retry with a corrected query.

CRITICAL: You MUST provide a final text answer to the Orchestrator describing what you found or reporting that no data was found. Do NOT end the turn without a text response.`,
        tools: [listTables, getTableSchema, executeBigQuery],
        beforeModelCallback: (params) => {
            console.log("\n  [SqlSpecialist] --> 🔎 Analyzing (Sending request to model)...");
            return undefined;
        },
        afterModelCallback: (params) => {
            console.log("\n  [SqlSpecialist] <-- 🧠 Decision made:");
            const response = params.response as any;
            if (response.candidates && response.candidates[0].content.parts) {
                response.candidates[0].content.parts.forEach((part: any) => {
                    if (part.text) {
                        console.log(`  [SqlSpecialist] 🗣️  Text: ${part.text}`);
                    }
                    if (part.functionCall) {
                        console.log(`  [SqlSpecialist] 🛠️  Tool Call: ${part.functionCall.name}`);
                    }
                });
            }
            return undefined;
        }
    });
};
