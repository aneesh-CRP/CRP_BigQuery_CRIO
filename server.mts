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

// Store runners per user token (each user gets their own authenticated runner)
const runnerCache = new Map<string, Runner>();

function getOrCreateRunner(authToken?: string): Runner {
    const cacheKey = authToken || '__default__';

    if (runnerCache.has(cacheKey)) {
        return runnerCache.get(cacheKey)!;
    }

    // Create a new agent with the user's auth token
    const agent = createRootAgent(authToken);

    const runner = new Runner({
        appName: 'clinical-research-agent',
        agent,
        sessionService,
    });

    runnerCache.set(cacheKey, runner);
    console.log(`[Runner] Created new runner for user (cached: ${runnerCache.size})`);

    return runner;
}

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
        const runner = getOrCreateRunner(this.authToken);

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

            // Run the ADK agent and stream events
            for await (const event of runner.runAsync({
                userId,
                sessionId: threadId,
                newMessage,
            })) {
                // Extract text content from the event
                const text = stringifyContent(event);

                if (text && event.author !== 'user') {
                    yield {
                        type: EventType.TEXT_MESSAGE_CONTENT,
                        messageId,
                        delta: text + '\n\n', // Add spacing between agent responses
                    } as any;
                }

                // Log tool calls for debugging
                const functionCalls = (event as any).content?.parts?.filter((p: any) => p.functionCall);
                if (functionCalls?.length) {
                    for (const fc of functionCalls) {
                        console.log(`[AdkAgent] Tool call: ${fc.functionCall.name}`);
                    }
                }
            }
        } catch (error: any) {
            console.error("[AdkAgent] Error in runner.runAsync:", error);
            yield {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: `\n\nError executing agent: ${error.message}`,
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
