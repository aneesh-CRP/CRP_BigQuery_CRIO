import 'reflect-metadata';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {
    CopilotRuntime,
    copilotRuntimeNodeHttpEndpoint,
} from '@copilotkit/runtime';
import { AbstractAgent, RunAgentInput, BaseEvent, EventType } from '@ag-ui/client';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { from } from 'rxjs';
import * as crypto from 'crypto';

// ADK imports
import { Runner, InMemorySessionService, stringifyContent, isFinalResponse } from '@google/adk';
import { createRootAgent } from './agent.ts';

console.log("[Server] Starting CopilotKit + ADK server...");
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

const PORT = 8080;

// Error handlers
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// --- ADK Session Management ---
const sessionService = new InMemorySessionService();

// Store runners and their log handlers
interface CachedRunner {
    runner: Runner;
    setLogHandler: (handler: (msg: string) => void) => void;
}
const runnerCache = new Map<string, CachedRunner>();

function getOrCreateRunner(authToken?: string): CachedRunner {
    const cacheKey = authToken || '__default__';

    if (runnerCache.has(cacheKey)) {
        return runnerCache.get(cacheKey)!;
    }

    // Create a new agent with the user's auth token
    const { agent, setLogHandler } = createRootAgent(authToken);

    const runner = new Runner({
        appName: 'clinical-research-agent',
        agent,
        sessionService,
    });

    const cached = { runner, setLogHandler };
    runnerCache.set(cacheKey, cached);
    console.log(`[Runner] Created new runner for user (cached: ${runnerCache.size})`);

    return cached;
}

// Global event emitter for sub-agent logs (simple workaround)
import { EventEmitter } from 'events';
export const logEmitter = new EventEmitter();

// --- ADK Agent Wrapper for CopilotKit ---
class AdkAgent extends AbstractAgent {
    private authToken?: string;

    constructor() {
        super();
        this.run = this.run.bind(this);
        this.executeRun = this.executeRun.bind(this);
    }

    // Set auth token from request (called before run)
    setAuthToken(token?: string) {
        this.authToken = token;
    }

    run(input: RunAgentInput) {
        return from(this.executeRun(input));
    }

    async *executeRun(input: RunAgentInput): AsyncGenerator<BaseEvent> {
        const runId = input.runId || crypto.randomUUID();
        const threadId = input.threadId || 'default';
        const messageId = crypto.randomUUID();

        // Get the runner for this user
        const { runner, setLogHandler } = getOrCreateRunner(this.authToken);

        // Get the user's message
        const userMessages = (input.messages || []).filter(m => m.role === 'user');
        const lastUserMessage = userMessages[userMessages.length - 1];

        if (!lastUserMessage) {
            console.warn('[AdkAgent] No user message found in input');
            return;
        }

        yield {
            type: EventType.RUN_STARTED,
            runId,
            threadId,
        } as any;

        yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: 'assistant'
        } as any;

        try {
            // Convert message to ADK format (Content)
            const newMessage = {
                role: 'user' as const,
                parts: [{ text: lastUserMessage.content as string }],
            };

            console.log('[AdkAgent] Running agent with message:', (lastUserMessage.content as string).substring(0, 50));

            // Ensure session exists before running (ADK requires this)
            const userId = 'copilotkit-user';
            const appName = 'clinical-research-agent';
            let session = await sessionService.getSession({ appName, userId, sessionId: threadId });
            if (!session) {
                console.log('[AdkAgent] Creating new session:', threadId);
                session = await sessionService.createSession({ appName, userId, sessionId: threadId });
            }

            try {
                // Setup log queue for this run
                const logQueue: string[] = [];

                // Signal to wake up the loop when a log arrives
                let logSignalResolver: (() => void) | null = null;
                let logSignal = new Promise<void>(resolve => { logSignalResolver = resolve; });

                // Attach the dynamic handler for this specific run
                setLogHandler((msg) => {
                    logQueue.push(msg);
                    if (logSignalResolver) {
                        logSignalResolver();
                        // Reset signal
                        logSignal = new Promise<void>(resolve => { logSignalResolver = resolve; });
                    }
                });

                // Run the ADK agent and stream events
                console.log('[AdkAgent] Starting runner.runAsync loop with real-time streaming...');

                const iterator = runner.runAsync({
                    userId,
                    sessionId: threadId,
                    newMessage,
                });

                // Start the first iterator promise
                let pendingNext = iterator.next();

                while (true) {
                    // 1. Flush any pending logs FIRST (and continuously if they keep coming)
                    while (logQueue.length > 0) {
                        const logMsg = logQueue.shift();
                        if (logMsg) {
                            yield {
                                type: EventType.TEXT_MESSAGE_CONTENT,
                                messageId,
                                delta: logMsg,
                            } as any;
                        }
                    }

                    // 2. Race: Wait for EITHER the next agent event OR a new log
                    const result = await Promise.race([
                        pendingNext.then(res => ({ type: 'event', res })),
                        logSignal.then(() => ({ type: 'log', res: null }))
                    ]);

                    if (result.type === 'log') {
                        // A new log arrived! Loop back to step 1 to flush it.
                        // We DO NOT touch pendingNext; it's still running in the background.
                        continue;
                    }

                    // It was an agent event
                    const { value: event, done } = (result as any).res;

                    if (done) {
                        break;
                    }

                    // 3. Queue the NEXT event promise immediately
                    pendingNext = iterator.next();

                    // 4. Process the received event
                    console.log(`[AdkAgent] Received event: ${JSON.stringify(event, null, 2)}`);

                    // Extract text content from the event
                    const text = stringifyContent(event);
                    console.log(`[AdkAgent] stringifyContent result: "${text}"`);

                    if (text && event.author !== 'user') {
                        yield {
                            type: EventType.TEXT_MESSAGE_CONTENT,
                            messageId,
                            delta: text + '\n\n', // Add spacing between agent responses
                        } as any;
                    }

                    // Handle tool calls - Emit them as formatted text/markdown
                    const functionCalls = (event as any).content?.parts?.filter((p: any) => p.functionCall);
                    if (functionCalls?.length) {
                        for (const fc of functionCalls) {
                            const toolName = fc.functionCall.name;
                            const args = fc.functionCall.args;
                            console.log(`[AdkAgent] Tool call: ${toolName}`);

                            let toolMessage = '';
                            if (toolName === 'execute_bigquery_query') {
                                const query = args?.query || 'No query provided';
                                toolMessage = `\n\n> 📊 **Executing SQL:**\n\`\`\`sql\n${query}\n\`\`\`\n\n`;
                            } else if (toolName === 'list_tables') {
                                toolMessage = `\n\n> 🔎 **Listing Tables** passed...\n\n`;
                            } else if (toolName === 'get_table_schema') {
                                toolMessage = `\n\n> 📋 **Checking Schema:** \`${args?.tableName}\`\n\n`;
                            } else {
                                toolMessage = `\n\n> 🛠️ **Using Tool:** \`${toolName}\`\n\n`;
                            }

                            // Stream the tool call notification to the chat
                            yield {
                                type: EventType.TEXT_MESSAGE_CONTENT,
                                messageId,
                                delta: toolMessage,
                            } as any;
                        }
                    }
                }

                // Flush any remaining logs after loop
                while (logQueue.length > 0) {
                    const logMsg = logQueue.shift();
                    if (logMsg) {
                        yield {
                            type: EventType.TEXT_MESSAGE_CONTENT,
                            messageId,
                            delta: logMsg,
                        } as any;
                    }
                }

                console.log('[AdkAgent] Finished runner.runAsync loop normally.');
            } catch (error) {
                console.error('[AdkAgent] Error in runner loop:', error);
            }
        } catch (error: any) {
            console.error("[AdkAgent] Error in runner.runAsync:", error);
            yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: `\n\n❌ **Error executing agent:** ${error.message}\n\n`,
            } as any;
        }

        yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId,
        } as any;

        yield {
            type: EventType.RUN_FINISHED,
            runId,
            threadId,
        } as any;
    }
}

// --- CopilotKit Runtime Setup ---
const adkAgent = new AdkAgent();

const copilotKit = new CopilotRuntime({
    agents: {
        'default': adkAgent
    },
});

// Workaround for CopilotKit Runtime bug
class DummyAdapter {
    async process(request: any): Promise<any> {
        return {
            stream: new ReadableStream({
                start(controller) { controller.close(); }
            })
        };
    }
}

const handler = copilotRuntimeNodeHttpEndpoint({
    endpoint: '/',
    runtime: copilotKit,
    serviceAdapter: new DummyAdapter() as any,
});

// Custom middleware to extract auth token and pass to agent
app.use('/copilotkit', (req, res, next) => {
    // Extract Bearer token from Authorization header
    const authHeader = req.headers.authorization;
    const userToken = authHeader?.startsWith('Bearer ')
        ? authHeader.substring(7)
        : undefined;

    if (userToken) {
        console.log('[Auth] Request with user token (length:', userToken.length, ')');
        adkAgent.setAuthToken(userToken);
    } else {
        console.log('[Auth] Request without auth - using default credentials');
        adkAgent.setAuthToken(undefined);
    }

    return handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        mode: 'ADK',
        projectId: process.env.GOOGLE_CLOUD_PROJECT || 'crio-468120',
    });
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`CopilotKit endpoint at http://localhost:${PORT}/copilotkit`);
    console.log(`Using ADK with user-level authentication`);
});
