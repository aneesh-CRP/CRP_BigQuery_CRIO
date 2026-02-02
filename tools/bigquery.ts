import { FunctionTool } from '@google/adk';
import { BigQuery } from '@google-cloud/bigquery';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
// @ts-ignore
import schemaData from '../schema.json' with { type: "json" };
// @ts-ignore
import config from '../config.json' with { type: "json" };

// Define schema types
type Column = {
    column: string;
    type: string;
    description: string;
};

type Table = {
    tableName: string;
    columns: Column[];
};

const schema = schemaData as Table[];

// Load from config (can be overridden by env vars)
const projectId = process.env.GOOGLE_CLOUD_PROJECT || config.projectId;
const datasetId = config.datasetId;
const location = process.env.GOOGLE_CLOUD_LOCATION || config.location;

/**
 * Creates BigQuery tools with optional user authentication.
 * @param authToken - User's OAuth2 access token for BigQuery. If provided, queries run as user (for RLS).
 */
export const createBigQueryTools = (authToken?: string) => {
    let bigquery: BigQuery;

    if (authToken) {
        // Create an OAuth2 client with the user's access token
        const authClient = new OAuth2Client();
        authClient.setCredentials({ access_token: authToken });

        // Initialize BigQuery with the user's credentials
        bigquery = new BigQuery({
            projectId,
            authClient: authClient as any, // BigQuery accepts GoogleAuth compatible clients
        });
        console.log('[BigQuery] Initialized with user OAuth token');
    } else {
        // Fallback to Application Default Credentials (service account)
        bigquery = new BigQuery({ projectId });
        console.log('[BigQuery] Initialized with Application Default Credentials');
    }

    const listTables = new FunctionTool({
        name: 'list_tables',
        description: 'Lists all available table names in the clinical research database.',
        parameters: z.object({}),
        execute: async () => {
            const tables = schema.map(t => t.tableName);
            return {
                status: 'success',
                report: `Available tables in dataset '${datasetId}':\n${tables.join('\n')}`
            };
        },
    });

    const getTableSchema = new FunctionTool({
        name: 'get_table_schema',
        description: 'Get the detailed schema (columns, types, descriptions) for a specific table.',
        parameters: z.object({
            tableName: z.string().describe("The name of the table (e.g., 'patient', 'study')."),
        }),
        execute: async ({ tableName }) => {
            const table = schema.find(t => t.tableName === tableName);
            if (!table) {
                return { status: 'error', report: `Table '${tableName}' not found in schema definitions.` };
            }
            const columnsReport = table.columns.map(c =>
                `- ${c.column} (${c.type}): ${c.description || 'No description'}`
            ).join('\n');

            return {
                status: 'success',
                report: `Schema for table '${tableName}':\n${columnsReport}`
            };
        },
    });

    const executeBigQuery = new FunctionTool({
        name: 'execute_bigquery_query',
        description: 'Executes a SQL query against the BigQuery database. Use this to retrieve actual data.',
        parameters: z.object({
            query: z.string().describe(`The Standard SQL query to execute. 
                IMPORTANT: Always fully qualify tables using \`${projectId}.${datasetId}.TableName\`. 
                Example: SELECT count(*) FROM \`${projectId}.${datasetId}.patient\``),
        }),
        execute: async ({ query }) => {
            try {
                console.log(`[BigQuery] Executing query: ${query.substring(0, 100)}...`);
                const options = {
                    query: query,
                    location: 'US',
                };

                const [rows] = await bigquery.query(options);

                if (!rows || rows.length === 0) {
                    return { status: 'success', report: 'Query executed successfully but returned no results.' };
                }

                // Format results as JSON string for the agent to parse
                return {
                    status: 'success',
                    report: `Query Results (${rows.length} rows):\n${JSON.stringify(rows, null, 2)}`
                };
            } catch (error: any) {
                console.error('[BigQuery] Query error:', error.message);
                return {
                    status: 'error',
                    report: `BigQuery Execution Error: ${error.message}`
                };
            }
        },
    });

    return { listTables, getTableSchema, executeBigQuery };
};
