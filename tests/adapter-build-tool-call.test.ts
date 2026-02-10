import { describe, it, expect } from 'vitest';

/**
 * Tests the buildToolCall logic from ag-ui-adk/src/adapter.ts
 * Extracted here to verify the serialization fix (session 1 bug).
 *
 * The key invariant: `toolCalls[].function.arguments` MUST be a string,
 * not an object. AG-UI's zod schema requires this.
 */

// Reproduce the buildToolCall logic from the adapter
function buildToolCall(msg: any) {
    const meta = msg.metadata || {};
    const toolName =
        meta.name ||
        (msg.type === 'sql_query' ? 'execute_bigquery_query' : undefined);
    if (!toolName) return null;

    const args =
        meta.args ??
        (meta.query ? { query: meta.query } : undefined);

    return {
        id: meta.toolCallId || msg.id,
        type: 'function',
        function: {
            name: toolName,
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
    };
}

describe('buildToolCall', () => {
    it('serializes object args to JSON string', () => {
        const msg = {
            id: 'msg-1',
            type: 'sql_query',
            metadata: {
                name: 'execute_bigquery_query',
                args: { query: 'SELECT 1' },
                toolCallId: 'tc-1',
            },
        };
        const result = buildToolCall(msg);
        expect(result).not.toBeNull();
        expect(typeof result!.function.arguments).toBe('string');
        expect(JSON.parse(result!.function.arguments)).toEqual({ query: 'SELECT 1' });
    });

    it('keeps string args as-is', () => {
        const msg = {
            id: 'msg-2',
            metadata: {
                name: 'list_tables',
                args: '{}',
                toolCallId: 'tc-2',
            },
        };
        const result = buildToolCall(msg);
        expect(result!.function.arguments).toBe('{}');
    });

    it('handles null/undefined args gracefully', () => {
        const msg = {
            id: 'msg-3',
            metadata: {
                name: 'list_tables',
                toolCallId: 'tc-3',
            },
        };
        const result = buildToolCall(msg);
        expect(typeof result!.function.arguments).toBe('string');
        expect(result!.function.arguments).toBe('{}');
    });

    it('falls back to query from metadata when args missing', () => {
        const msg = {
            id: 'msg-4',
            type: 'sql_query',
            metadata: {
                name: 'execute_bigquery_query',
                query: 'SELECT count(*) FROM patients',
                toolCallId: 'tc-4',
            },
        };
        const result = buildToolCall(msg);
        expect(typeof result!.function.arguments).toBe('string');
        const parsed = JSON.parse(result!.function.arguments);
        expect(parsed.query).toBe('SELECT count(*) FROM patients');
    });

    it('returns null for messages without tool name', () => {
        const msg = {
            id: 'msg-5',
            type: 'text',
            metadata: {},
        };
        expect(buildToolCall(msg)).toBeNull();
    });

    it('uses sql_query type as fallback for tool name', () => {
        const msg = {
            id: 'msg-6',
            type: 'sql_query',
            metadata: {
                query: 'SELECT 1',
            },
        };
        const result = buildToolCall(msg);
        expect(result!.function.name).toBe('execute_bigquery_query');
    });
});
