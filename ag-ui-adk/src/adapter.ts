
import { AbstractAgent, RunAgentInput, BaseEvent, EventType } from '@ag-ui/client';
import { from } from 'rxjs';
import * as crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { stringifyContent } from '@google/adk';
import {
    AdkAdapterConfig,
    HistoryServiceAdapter,
    RunnerFactory,
    SessionServiceAdapter
} from './types.js';

/**
 * ADK Agent Wrapper for CopilotKit via AG-UI Protocol
 */
export class AdkAgent extends AbstractAgent {
    constructor(
        private config: AdkAdapterConfig,
        private historyService: HistoryServiceAdapter,
        private runnerFactory: RunnerFactory,
        private sessionService: SessionServiceAdapter
    ) {
        super();
    }

    override clone(): this {
        const cloned = super.clone() as this;
        (cloned as any).config = this.config;
        (cloned as any).historyService = this.historyService;
        (cloned as any).runnerFactory = this.runnerFactory;
        (cloned as any).sessionService = this.sessionService;
        return cloned;
    }

    override prepareRunAgentInput(input: RunAgentInput = {} as RunAgentInput): RunAgentInput {
        const hasMessages = typeof input.messages !== 'undefined';
        const hasState = typeof input.state !== 'undefined';

        if (input.threadId) {
            this.threadId = input.threadId;
        }
        if (hasMessages) {
            this.messages = input.messages as any;
        }
        if (hasState) {
            this.state = input.state as any;
        }

        return {
            threadId: input.threadId || this.threadId,
            runId: input.runId || crypto.randomUUID(),
            tools: input.tools || [],
            context: input.context || [],
            forwardedProps: input.forwardedProps || {},
            state: hasState ? input.state : this.state,
            messages: hasMessages ? input.messages : this.messages,
        };
    }

    override connect(input: RunAgentInput) {
        return from(this.executeConnect(input));
    }

    async *executeConnect(input: RunAgentInput): AsyncGenerator<BaseEvent> {
        console.log('[AdkAgent] connect() called - restoring history');
        const runId = input.runId || crypto.randomUUID();
        const threadId = input.threadId || 'default';

        yield { type: EventType.RUN_STARTED, runId, threadId } as any;

        // Emit history snapshot
        yield* this.emitHistorySnapshot(threadId);

        yield { type: EventType.RUN_FINISHED, runId, threadId } as any;
    }

    private async *emitHistorySnapshot(threadId: string): AsyncGenerator<BaseEvent> {
        try {
            const dbMessages = await this.historyService.getThreadMessages(threadId, 100);
            if (dbMessages.length > 0) {
                console.log(`[AdkAgent] Emitting MESSAGES_SNAPSHOT with ${dbMessages.length} historical messages`);
                const agUIMessages: any[] = [];
                let pendingToolCalls: any[] = [];
                const pendingToolKeys = new Map<string, number>();

                const normalizeArgs = (args: any) => {
                    if (!args) return undefined;
                    if (typeof args === 'string') return args;
                    if (typeof args === 'object') return args;
                    return undefined;
                };

                const computeArgsKey = (args: any) => {
                    const normalized = normalizeArgs(args);
                    if (typeof normalized === 'string') {
                        const trimmed = normalized.trim();
                        return trimmed.length ? JSON.stringify(trimmed) : '__empty__';
                    }
                    if (normalized && typeof normalized === 'object') {
                        const keys = Object.keys(normalized);
                        if (!keys.length) return '__empty__';
                        try {
                            return JSON.stringify(normalized);
                        } catch {
                            return '__unserializable__';
                        }
                    }
                    return '__empty__';
                };

                const buildToolCall = (msg: any) => {
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
                };

                const addPendingToolCall = (toolCall: any) => {
                    if (!toolCall) return;
                    const toolName = toolCall.function?.name || 'unknown';
                    const argsKey = computeArgsKey(toolCall.function?.arguments);
                    const key = `${toolName}:${argsKey}`;

                    if (pendingToolKeys.has(key)) {
                        return;
                    }

                    if (argsKey === '__empty__') {
                        // Skip empty-args duplicates when a richer entry already exists.
                        for (const existingKey of pendingToolKeys.keys()) {
                            if (existingKey.startsWith(`${toolName}:`) && !existingKey.endsWith(':__empty__')) {
                                return;
                            }
                        }
                    } else {
                        // Replace empty-args placeholder if present.
                        const emptyKey = `${toolName}:__empty__`;
                        if (pendingToolKeys.has(emptyKey)) {
                            const idx = pendingToolKeys.get(emptyKey)!;
                            pendingToolCalls[idx] = toolCall;
                            pendingToolKeys.delete(emptyKey);
                            pendingToolKeys.set(key, idx);
                            return;
                        }
                    }

                    pendingToolKeys.set(key, pendingToolCalls.length);
                    pendingToolCalls.push(toolCall);
                };

                for (const msg of dbMessages) {
                    if (msg.role === 'tool') {
                        const toolCall = buildToolCall(msg);
                        addPendingToolCall(toolCall);
                        continue;
                    }

                    if (msg.role === 'assistant') {
                        const assistantMsg: any = {
                            id: msg.id,
                            role: 'assistant',
                            content: msg.content,
                        };
                        if (pendingToolCalls.length) {
                            assistantMsg.toolCalls = pendingToolCalls;
                            pendingToolCalls = [];
                            pendingToolKeys.clear();
                        }
                        agUIMessages.push(assistantMsg);
                        continue;
                    }

                    if (msg.role === 'user') {
                        agUIMessages.push({
                            id: msg.id,
                            role: 'user',
                            content: msg.content,
                        });
                        continue;
                    }
                }

                if (pendingToolCalls.length) {
                    const lastAssistant = [...agUIMessages].reverse().find(m => m.role === 'assistant');
                    if (lastAssistant) {
                        lastAssistant.toolCalls = [
                            ...(lastAssistant.toolCalls || []),
                            ...pendingToolCalls,
                        ];
                    } else {
                        agUIMessages.push({
                            id: crypto.randomUUID(),
                            role: 'assistant',
                            content: '',
                            toolCalls: pendingToolCalls,
                        });
                    }
                }

                yield {
                    type: EventType.MESSAGES_SNAPSHOT,
                    messages: agUIMessages,
                } as any;
            }
        } catch (historyErr) {
            console.error('[AdkAgent] Failed to load history for MESSAGES_SNAPSHOT:', historyErr);
        }
    }

    override run(input: RunAgentInput) {
        console.log('[AdkAgent] run() called', JSON.stringify({
            runId: input.runId,
            threadId: input.threadId,
            messageCount: input.messages?.length || 0
        }));
        return from(this.executeRun(input));
    }

    async *executeRun(input: RunAgentInput): AsyncGenerator<BaseEvent> {
        const runId = input.runId || crypto.randomUUID();
        const threadId = input.threadId || 'default';
        const messageId = crypto.randomUUID();
        let messageStarted = false;
        let messageEnded = false;
        let runFinished = false;

        try {
            // 1. Context & Auth Extraction
            const inputContext = (input as any).context || {};
            const forwardedProps = (input as any).forwardedProps || {};

            const providedEmail = forwardedProps.userEmail || forwardedProps.properties?.userEmail || inputContext.userEmail;
            const authToken = forwardedProps.authToken || forwardedProps.properties?.authToken;

            console.log('[AdkAgent] Auth context:', { hasEmail: !!providedEmail, hasToken: !!authToken });

            // Find latest user message (if any)
            const userMessages = (input.messages || []).filter(m => m.role === 'user');
            const lastUserMessage = userMessages[userMessages.length - 1];

            // Start run event stream
            yield { type: EventType.RUN_STARTED, runId, threadId } as any;

            // 2. Token Verification
            let verifiedEmail = 'anonymous_user';

            if (authToken) {
                try {
                    console.log('[AdkAgent] Verifying token with Google...');
                    const authClient = new OAuth2Client();
                    const tokenInfo = await authClient.getTokenInfo(authToken);
                    if (tokenInfo.email) {
                        verifiedEmail = tokenInfo.email;
                        console.log('[AdkAgent] Token verified. Authenticated as:', verifiedEmail);
                    } else {
                        console.warn('[AdkAgent] Token valid but no email found inside.');
                    }
                } catch (e) {
                    console.error('[AdkAgent] Token verification failed:', e);
                    const errorMessage = `\n\n❌ **Security Warning:** Logic failed to verify your session token. Please sign in again.\n\n`;
                    yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' } as any;
                    messageStarted = true;
                    yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: errorMessage } as any;
                    yield { type: EventType.TEXT_MESSAGE_END, messageId } as any;
                    messageEnded = true;
                    yield { type: EventType.RUN_FINISHED, runId, threadId } as any;
                    runFinished = true;
                    return;
                }
            } else {
                console.warn('[AdkAgent] No authToken provided in request.');
            }

            const currentUserId = verifiedEmail;
            const userEmail = currentUserId;

            // If no user message, just sync history and exit
            if (!lastUserMessage) {
                console.log('[AdkAgent] No user message found in input. Treating as state sync.');
                yield* this.emitHistorySnapshot(threadId);
                yield { type: EventType.RUN_FINISHED, runId, threadId } as any;
                runFinished = true;
                return;
            }

            // 3. User & Thread Context
            try {
                await this.historyService.ensureUser(userEmail); // Ensure user exists
            } catch (dbError) {
                console.error('[DB] Failed to ensure user/thread context:', dbError);
            }

            // 4. Get Agent Runner
            const { runner, setLogHandler } = await this.runnerFactory.getOrCreateRunner(authToken);

            // 6. Persist User Message & Thread Creation
            try {
                const user = await this.historyService.ensureUser(userEmail);
                let dbThread = await this.historyService.getThread(threadId);

                if (!dbThread) {
                    try {
                        const title = lastUserMessage.content && typeof lastUserMessage.content === 'string'
                            ? (lastUserMessage.content.substring(0, 30) + '...')
                            : 'New Chat';

                        dbThread = await this.historyService.createThread(user.id, title, threadId);
                    } catch (e) {
                        console.error('[DB] Failed to create thread, might already exist:', e);
                        dbThread = await this.historyService.getThread(threadId);
                    }
                }

                if (dbThread) {
                    await this.historyService.addMessage(threadId, 'user', lastUserMessage.content as string);

                    if (dbThread.title === 'New Chat') {
                        const split = (lastUserMessage.content as string).split(' ');
                        const newTitle = split.slice(0, 5).join(' ') + (split.length > 5 ? '...' : '');
                        await this.historyService.updateThreadTitle(threadId, newTitle);
                    }
                }
            } catch (err) {
                console.error('[DB] Failed to save user message:', err);
            }

            // 7. AG-UI HISTORY RESTORATION
            // We emit this on run too, just in case context was lost
            yield* this.emitHistorySnapshot(threadId);

            // 8. Start Run Events
            yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' } as any;
            messageStarted = true;

        let assistantResponseAccumulator = '';

            try {
            // 9. Prepare ADK Session
            const userIdContext = currentUserId || 'anonymous_user';
            const appName = this.config.branding.appName.replace(/\s+/g, '-').toLowerCase();

            let session = await this.sessionService.getSession({ appName, userId: userIdContext, sessionId: threadId });
            if (!session) {
                console.log('[AdkAgent] Creating new session:', threadId);
                session = await this.sessionService.createSession({ appName, userId: userIdContext, sessionId: threadId });
            }

            // Inject History into Session (Context for Agent)
            if (session.events.length === 0) {
                console.log('[AdkAgent] Session is empty, attempting to load DB history into ADK session:', threadId);
                try {
                    const dbMessages = await this.historyService.getThreadMessages(threadId, 50);
                    if (dbMessages.length > 0) {
                        for (const dbMsg of dbMessages) {
                            if (dbMsg.role === 'tool') {
                                continue;
                            }
                            const adkEvent = {
                                id: dbMsg.id,
                                invocationId: `history-${dbMsg.id}`,
                                author: dbMsg.role === 'user' ? 'user' : this.config.agent.orchestrator.name,
                                timestamp: new Date(dbMsg.createdAt).getTime(),
                                content: {
                                    role: dbMsg.role === 'user' ? 'user' as const : 'model' as const,
                                    parts: [{ text: dbMsg.content }],
                                },
                                actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {} },
                            };
                            await this.sessionService.appendEvent({ session, event: adkEvent as any });
                        }
                        console.log('[AdkAgent] Successfully injected DB history into session');
                    }
                } catch (historyErr) {
                    console.error('[AdkAgent] Failed to load/inject DB history:', historyErr);
                }
            }

            // 10. Run Agent
            // Setup log capture
            const logQueue: string[] = [];
            const logHandler = (msg: unknown) => {
                if (typeof msg === 'string') {
                    logQueue.push(msg);
                    return;
                }
                try {
                    logQueue.push(JSON.stringify(msg));
                } catch {
                    logQueue.push(String(msg));
                }
            };
            setLogHandler(logHandler);

            // Invoke Runner
            const userText = typeof lastUserMessage.content === 'string'
                ? lastUserMessage.content
                : JSON.stringify(lastUserMessage.content ?? '');

            const iterator = runner.runAsync({
                userId: session.userId || userIdContext,
                sessionId: session.id,
                newMessage: {
                    role: 'user',
                    parts: [{ text: userText }],
                },
            });

            console.log('[AdkAgent] Starting runner.runAsync loop...');

            let pendingNext = iterator.next();
            const checkIntervalMs = 50;
            const seenToolEvents = new Set<string>();
            const makeToolKey = (toolName: string, args: any) => {
                try {
                    const normalizedArgs =
                        typeof args === 'string'
                            ? args
                            : args && typeof args === 'object'
                                ? args
                                : {};
                    return `${toolName}:${JSON.stringify(normalizedArgs)}`;
                } catch {
                    return `${toolName}:__unserializable__`;
                }
            };

            // Loop until complete
            while (true) {
                const logSignal = new Promise<{ type: 'log'; res: null }>((resolve) =>
                    setTimeout(() => resolve({ type: 'log', res: null }), checkIntervalMs)
                );

                const nextSignal = pendingNext.then((res: any) => ({ type: 'next', res }));

                const result = await Promise.race([nextSignal, logSignal]);

                // Flush logs and surface tool activity to the UI
                while (logQueue.length > 0) {
                    const rawLog = logQueue.shift();
                    if (!rawLog) continue;
                    const logMsg = typeof rawLog === 'string' ? rawLog : String(rawLog);
                    if (!logMsg) continue;
                    const logLower = logMsg.toLowerCase();
                    const isToolLog =
                        logLower.includes('executing sql') ||
                        logLower.includes('finding schema') ||
                        logLower.includes('reading columns for table') ||
                        logLower.includes('listing all tables');

                    if (!isToolLog) continue;

                    const buildToolEvents = (toolCallId: string, toolName: string, args: Record<string, any>) => {
                        const events: BaseEvent[] = [
                            {
                                type: EventType.TOOL_CALL_START,
                                toolCallId,
                                toolCallName: toolName,
                                parentMessageId: messageId,
                            } as any
                        ];
                        const argsString = JSON.stringify(args ?? {});
                        if (argsString && argsString !== '{}') {
                            events.push({
                                type: EventType.TOOL_CALL_ARGS,
                                toolCallId,
                                delta: argsString,
                            } as any);
                        }
                        events.push({
                            type: EventType.TOOL_CALL_END,
                            toolCallId,
                        } as any);
                        return events;
                    };

                    if (logLower.includes('executing sql')) {
                        // Extract SQL from fenced block if present
                        const match = logMsg.match(/```sql\s*([\s\S]*?)```/i);
                        const query = match?.[1]?.trim() || logMsg;
                        const toolKey = makeToolKey('execute_bigquery_query', { query });
                        if (seenToolEvents.has(toolKey)) {
                            continue;
                        }
                        seenToolEvents.add(toolKey);
                        const toolCallId = crypto.randomUUID();
                        try {
                            const toolMessage = `\n\n> 📊 **Executing SQL:**\n\`\`\`sql\n${query}\n\`\`\`\n\n`;
                            await this.historyService.addToolMessage(threadId, 'sql_query', toolMessage, {
                                name: 'execute_bigquery_query',
                                query,
                                args: { query },
                                toolCallId,
                                source: 'subagent',
                            });
                        } catch (e) {
                            console.error('[DB] Failed to save SQL tool message (log):', e);
                        }
                        for (const toolEvent of buildToolEvents(toolCallId, 'execute_bigquery_query', { query })) {
                            yield toolEvent as any;
                        }
                        continue;
                    }

                    if (logLower.includes('reading columns for table')) {
                        const match = logMsg.match(/table\s+`([^`]+)`/i);
                        const tableName = match?.[1] || 'unknown';
                        const toolKey = makeToolKey('get_table_schema', { tableName });
                        if (seenToolEvents.has(toolKey)) {
                            continue;
                        }
                        seenToolEvents.add(toolKey);
                        const toolCallId = crypto.randomUUID();
                        try {
                            const toolMessage = `\n\n> 🛠️ **Finding Schema:** Reading columns for table \`${tableName}\`\n\n`;
                            await this.historyService.addToolMessage(threadId, 'tool_call', toolMessage, {
                                name: 'get_table_schema',
                                args: { tableName },
                                toolCallId,
                                source: 'subagent',
                            });
                        } catch (e) {
                            console.error('[DB] Failed to save schema tool message (log):', e);
                        }
                        for (const toolEvent of buildToolEvents(toolCallId, 'get_table_schema', { tableName })) {
                            yield toolEvent as any;
                        }
                        continue;
                    }

                    if (logLower.includes('listing all tables')) {
                        const toolKey = makeToolKey('list_tables', {});
                        if (seenToolEvents.has(toolKey)) {
                            continue;
                        }
                        seenToolEvents.add(toolKey);
                        const toolCallId = crypto.randomUUID();
                        try {
                            const toolMessage = `\n\n> 📋 **Listing Database Tables**\n\n`;
                            await this.historyService.addToolMessage(threadId, 'tool_call', toolMessage, {
                                name: 'list_tables',
                                args: {},
                                toolCallId,
                                source: 'subagent',
                            });
                        } catch (e) {
                            console.error('[DB] Failed to save list tables tool message (log):', e);
                        }
                        for (const toolEvent of buildToolEvents(toolCallId, 'list_tables', {})) {
                            yield toolEvent as any;
                        }
                        continue;
                    }
                }

                if (result.type === 'log') {
                    continue;
                }

                const { value: event, done } = (result as any).res;
                if (done) break;

                pendingNext = iterator.next();

                // Log event type only (full event is too verbose for production)
                const eventAuthor = (event as any).author;
                console.log(`[AdkAgent] Event: author=${eventAuthor || 'unknown'}`);

                // Process Event content
                let text = stringifyContent(event);

                // Fallback content extraction (based on previous debug findings)
                const eventAny = event as any;
                if (!text && eventAny.content?.parts) {
                    for (const part of eventAny.content.parts) {
                        if (part.text) text += part.text;
                    }
                }
                if (!text && eventAny.message) {
                    text = typeof eventAny.message === 'string' ? eventAny.message : JSON.stringify(eventAny.message);
                }
                if (!text && eventAny.text) {
                    text = eventAny.text;
                }

                const hasFunctionCalls = (event as any).content?.parts?.some((p: any) => p.functionCall);
                const hasTextParts = (eventAny.content?.parts || []).some((p: any) => p.text);
                if (text && event.author !== 'user' && (!hasFunctionCalls || hasTextParts)) {
                    const chunk = text + '\n\n';
                    assistantResponseAccumulator += chunk;
                    yield {
                        type: EventType.TEXT_MESSAGE_CONTENT,
                        messageId,
                        delta: chunk,
                    } as any;
                }

                // Handle Tool Calls (emit explicit tool events + markdown hints)
                const functionCalls = (event as any).content?.parts?.filter((p: any) => p.functionCall);
                if (functionCalls?.length) {
                    for (const fc of functionCalls) {
                        const toolName = fc.functionCall.name;
                        const args = fc.functionCall.args;
                        const toolCallId = fc.functionCall.id || crypto.randomUUID();
                        console.log(`[AdkAgent] Tool call: ${toolName}`);
                        const uiArgs = args;
                        const hasObjectArgs = typeof uiArgs === 'object' && uiArgs !== null;
                        const argsString = hasObjectArgs ? JSON.stringify(uiArgs ?? {}) : '';
                        const toolKey = makeToolKey(toolName, uiArgs);
                        if (seenToolEvents.has(toolKey)) {
                            continue;
                        }
                        seenToolEvents.add(toolKey);

                        // Emit tool call events for UI
                        yield {
                            type: EventType.TOOL_CALL_START,
                            toolCallId,
                            toolCallName: toolName,
                            parentMessageId: messageId
                        } as any;
                        if (argsString && argsString !== '{}') {
                            yield {
                                type: EventType.TOOL_CALL_ARGS,
                                toolCallId,
                                delta: argsString
                            } as any;
                        }
                        yield {
                            type: EventType.TOOL_CALL_END,
                            toolCallId
                        } as any;

                        let toolMessage = `\n> 🛠️ **Tool Call**: \`${toolName}\`\n`;

                        // Custom formatting for known tools
                        if (toolName === 'execute_bigquery_query') {
                            const query = args?.query || 'No query provided';
                            toolMessage = `\n\n> 📊 **Executing SQL:**\n\`\`\`sql\n${query}\n\`\`\`\n\n`;

                            // Log to history
                            try {
                                await this.historyService.addToolMessage(threadId, 'sql_query', toolMessage, { name: toolName, query, args, toolCallId });
                            } catch (e) {
                                console.error('[DB] Failed to save SQL tool message:', e);
                            }
                        } else if (toolName === 'list_tables') {
                            toolMessage = `\n\n> 📋 **Listing Database Tables**\n\n`;
                            try {
                                await this.historyService.addToolMessage(threadId, 'tool_call', toolMessage, { name: toolName, args, toolCallId });
                            } catch (e) { console.error('[DB] Failed to save tool call log:', e); }
                        } else {
                            // Default logging
                            try {
                                await this.historyService.addToolMessage(threadId, 'tool_call', toolMessage, { name: toolName, args, toolCallId });
                            } catch (e) { console.error('[DB] Failed to save tool call log:', e); }
                        }

                        // Keep history logging for tool calls, but avoid mixing into assistant text
                    }
                }

                // Handle Tool Results
                const functionResponses = (event as any).content?.parts?.filter((p: any) => p.functionResponse);
                if (functionResponses?.length) {
                    for (const fr of functionResponses) {
                        const toolName = fr.functionResponse.name;
                        if (toolName === 'sql_specialist') {
                            continue;
                        }
                        const toolCallId = fr.functionResponse.id || crypto.randomUUID();
                        const resultContent = fr.functionResponse.response?.result ?? fr.functionResponse.response ?? fr.functionResponse;
                        const resultString = typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent ?? {});

                        yield {
                            type: EventType.TOOL_CALL_RESULT,
                            messageId: crypto.randomUUID(),
                            toolCallId,
                            content: resultString,
                            role: 'tool'
                        } as any;
                    }
                }
            }

            console.log('[AdkAgent] Finished runner.runAsync loop.');

                // Save final assistant response
                if (assistantResponseAccumulator) {
                    await this.historyService.addMessage(threadId, 'assistant', assistantResponseAccumulator);
                }

            } catch (error: any) {
                console.error('[AdkAgent] Error in run loop:', error);
                const errorMessage = `\n\n**Error encountered:** ${error.message || 'Unknown error'}\n`;
                if (!messageStarted) {
                    yield { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' } as any;
                    messageStarted = true;
                }
                yield {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId,
                    delta: errorMessage
                } as any;
                // Save error message to history — wrapped to avoid masking the original error
                try {
                    await this.historyService.addMessage(threadId, 'assistant', errorMessage);
                } catch (dbErr) {
                    console.error('[AdkAgent] Failed to persist error message to DB:', dbErr);
                }
            }
        } finally {
            if (messageStarted && !messageEnded) {
                yield { type: EventType.TEXT_MESSAGE_END, messageId } as any;
                messageEnded = true;
            }
            if (!runFinished) {
                yield { type: EventType.RUN_FINISHED, runId, threadId } as any;
                runFinished = true;
            }
        }
    }
}
