import { FunctionTool } from '@google/adk';
import { BigQuery } from '@google-cloud/bigquery';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { logger } from '../lib/logger.ts';
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
// BIGQUERY_PROJECT_ID: project that owns the dataset
// BIGQUERY_BILLING_PROJECT: project used to create query jobs (can differ)
// BIGQUERY_DATASET_ID: dataset id
// BIGQUERY_LOCATION: dataset location / job location
const getBigQueryConfig = () => {
    const projectId = process.env.BIGQUERY_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || config.gcp.projectId;
    const billingProjectId = process.env.BIGQUERY_BILLING_PROJECT || projectId;
    const datasetId = process.env.BIGQUERY_DATASET_ID || config.bigquery.datasetId;
    const location = process.env.BIGQUERY_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || config.gcp.location;
    return { projectId, billingProjectId, datasetId, location };
};

/**
 * Sanitize BigQuery errors before returning to the user/agent.
 * Strips project IDs, dataset names, locations, token info, and other infra details.
 */
export function sanitizeErrorForUser(rawMessage: string, reason?: string): string {
    if (reason === 'accessDenied' || /access denied/i.test(rawMessage)) {
        return 'BigQuery Error: Access denied. You may not have permission to query this dataset. Please check your access rights.';
    }
    if (reason === 'notFound' || /not found/i.test(rawMessage)) {
        return 'BigQuery Error: The requested table or dataset was not found. Please verify the table name.';
    }
    if (/timeout|deadline exceeded/i.test(rawMessage)) {
        return 'BigQuery Error: The query timed out. Try simplifying the query or reducing the data range.';
    }
    if (/exceeded.*bytes/i.test(rawMessage)) {
        return 'BigQuery Error: The query would scan too much data. Try adding filters or reducing the scope.';
    }
    if (/syntax error/i.test(rawMessage)) {
        // Syntax errors are safe to pass through — they contain the SQL, not infra details
        return `BigQuery SQL Error: ${rawMessage}`;
    }
    // Generic fallback — do not leak the raw message which may contain project/dataset info
    return `BigQuery Error: Query failed (${reason || 'unknown reason'}). Check the query and try again.`;
}

/**
 * Creates BigQuery tools with optional user authentication.
 * @param authToken - User's OAuth2 access token for BigQuery. If provided, queries run as user (for RLS).
 */
export const createBigQueryTools = (authToken?: string, onLog?: (msg: string) => void) => {
    let bigquery: BigQuery | null = null;
    let authClientForDebug: OAuth2Client | null = null;
    const logSql = process.env.DEBUG_SQL_LOGS === 'true';

    // Initialize BigQuery lazily - only when authToken is provided
    const getBigQuery = (): BigQuery => {
        if (bigquery) return bigquery;

        if (!authToken) {
            logger.error('[BigQuery] Security Error: Attempted to query without user token.');
            throw new Error("Authentication Failed: You must sign in with Google to access the data. No access token provided.");
        }

        // Create an OAuth2 client with the user's access token
        const authClient = new OAuth2Client();
        authClient.setCredentials({ access_token: authToken });
        authClientForDebug = authClient;

        const { projectId, billingProjectId, datasetId, location } = getBigQueryConfig();

        // Initialize BigQuery with the user's credentials
        bigquery = new BigQuery({
            projectId: billingProjectId,
            location,
            authClient: authClient as any,
        });
        logger.info('[BigQuery] Initialized with user OAuth token');
        logger.debug({ billingProjectId, projectId, datasetId, location }, '[BigQuery] Config');
        return bigquery;
    };

    const listTables = new FunctionTool({
        name: 'list_tables',
        description: 'Lists all available table names in the database.',
        parameters: z.object({}),
        execute: async () => {
            const { datasetId } = getBigQueryConfig();
            if (onLog) onLog(`\n\n> 🛠️ **Finding Schema:** Listing all tables...`);
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
            if (onLog) onLog(`\n\n> 🛠️ **Finding Schema:** Reading columns for table \`${tableName}\`...`);
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
                IMPORTANT: Always fully qualify tables using \`<project>.<dataset>.TableName\`.
                Example: SELECT count(*) FROM \`project_id.dataset_id.patient\``),
        }),
        execute: async ({ query }: { query: string }) => {
            const { billingProjectId, projectId, datasetId, location } = getBigQueryConfig();
            let normalizedQuery = query;
            // Replace placeholder tokens if the model used defaults
            normalizedQuery = normalizedQuery.replace(/\byour-project-id\b/g, projectId);
            normalizedQuery = normalizedQuery.replace(/\byour_dataset\b/g, datasetId);

            // Ensure backticked identifiers have project.dataset.table (add project if missing)
            normalizedQuery = normalizedQuery.replace(/`([^`]+)`/g, (full, identifier) => {
                const parts = identifier.split('.');
                if (parts.length === 2) {
                    return `\`${projectId}.${identifier}\``;
                }
                return full;
            });

            // Handle unquoted dataset.table in FROM/JOIN clauses (best-effort)
            normalizedQuery = normalizedQuery.replace(/\b(FROM|JOIN)\s+([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/gi, (full, keyword, ds, table) => {
                // If ds already equals projectId, leave it
                if (ds === projectId) return full;
                return `${keyword} ${projectId}.${ds}.${table}`;
            });

            if (normalizedQuery !== query) {
                logger.debug('[BigQuery] Normalized query identifiers for project/dataset defaults');
            }

            if (logSql) {
                logger.debug({ query: normalizedQuery }, '[BigQuery] Executing query');
            } else {
                logger.info('[BigQuery] Executing query (redacted)');
            }
            if (onLog) onLog(`\n\n> 📊 **Executing SQL:**\n\`\`\`sql\n${normalizedQuery}\n\`\`\`\n\n`);

            // 1. Check for dangerous keywords using word boundaries to avoid false positives (e.g., 'last_updated')
            const forbiddenParams = ['DELETE', 'DROP', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE', 'MERGE', 'GRANT', 'REVOKE'];
            const normalizedQueryUpper = normalizedQuery.toUpperCase();

            const hasForbidden = forbiddenParams.some(param => {
                // Check if the forbidden word exists as a whole word
                const regex = new RegExp(`\\b${param}\\b`, 'i');
                return regex.test(normalizedQueryUpper);
            });

            if (hasForbidden) {
                throw new Error("Query contains forbidden keywords (DELETE, DROP, UPDATE, etc.). Read-only access only.");
            }

            try {
                const queryTimeoutMs = parseInt(process.env.BIGQUERY_TIMEOUT_MS || '30000', 10);
                const maxBytesBilled = process.env.BIGQUERY_MAX_BYTES_BILLED || '1073741824'; // 1 GB default
                const maxResults = parseInt(process.env.BIGQUERY_MAX_RESULTS || '1000', 10);

                const options = {
                    query: normalizedQuery,
                    location,
                    timeoutMs: queryTimeoutMs,
                    maximumBytesBilled: maxBytesBilled,
                    maxResults,
                };

                const [rows] = await getBigQuery().query(options);

                if (!rows || rows.length === 0) {
                    return { status: 'success', report: 'Query executed successfully but returned no results.' };
                }

                // 2. Redact sensitive fields (Post-processing)
                const sensitiveKeys = ['password', 'secret', 'hash', 'salt', 'token', 'credential'];
                const redactedRows = rows.map((row: any) => {
                    const cleanRow: any = { ...row };
                    for (const key in cleanRow) {
                        if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
                            cleanRow[key] = '[REDACTED]';
                        }
                    }
                    return cleanRow;
                });

                const truncated = redactedRows.length >= maxResults;
                const truncationNote = truncated ? `\n(Results truncated to ${maxResults} rows)` : '';

                // Format results as JSON string for the agent to parse
                return {
                    status: 'success',
                    report: `Query Results (${redactedRows.length} rows):${truncationNote}\n${JSON.stringify(redactedRows, null, 2)}`
                };
            } catch (error: any) {
                const errorMessage = error?.message || 'Unknown error';
                const errorReason = error?.errors?.[0]?.reason;

                // Log full details server-side for debugging
                logger.error({ err: errorMessage, reason: errorReason, query: normalizedQuery, billingProjectId, projectId, datasetId, location }, '[BigQuery] Query error');
                if (error?.errors?.length) {
                    logger.error({ details: error.errors }, '[BigQuery] Query error details');
                }
                if (errorReason === 'accessDenied' || /access denied/i.test(errorMessage)) {
                    logger.error('[BigQuery] Access denied. Check user permissions and billing project configuration.');
                }

                // Debug token info server-side only
                if (authClientForDebug && authToken) {
                    try {
                        const tokenInfo = await authClientForDebug.getTokenInfo(authToken);
                        logger.debug({ email: tokenInfo.email, scopes: tokenInfo.scopes }, '[BigQuery] Token info for failed query');
                    } catch (tokenErr) {
                        logger.error({ err: tokenErr }, '[BigQuery] Failed to fetch token info for debug');
                    }
                }

                // Return sanitized error to the agent — no infra details
                const safeMessage = sanitizeErrorForUser(errorMessage, errorReason);
                return {
                    status: 'error',
                    report: safeMessage
                };
            }
        },
    });

    return { listTables, getTableSchema, executeBigQuery };
};
