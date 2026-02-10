import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config(); // Must be first

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { LRUCache } from 'lru-cache';
import {
    CopilotRuntime,
    copilotRuntimeNodeHttpEndpoint,
} from '@copilotkit/runtime';
import { AbstractAgent, RunAgentInput, BaseEvent, EventType } from '@ag-ui/client';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { from, Observable, Subscription } from 'rxjs';
import * as crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';

// ADK imports
import { Runner, InMemorySessionService, stringifyContent, isFinalResponse } from '@google/adk';
import { createRootAgent } from './agent.ts';
import { historyService } from './services/history.ts';
import { DbSessionService } from './services/db-session-service.ts';
import { prisma } from './db.ts';
// @ts-ignore
import config from './config.json' with { type: "json" };
import { AdkAgent as AgUiAdkAgent, DummyAdapter } from 'ag-ui-adk';
import { InMemoryAgentRunner, AgentRunnerConnectRequest } from '@copilotkitnext/runtime';
import { logger } from './lib/logger.ts';

// --- Startup validation ---
const requiredEnvVars = ['DATABASE_URL', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
    logger.fatal({ missing: missingVars }, 'Missing required environment variables. Exiting.');
    process.exit(1);
}

const isProd = process.env.NODE_ENV === 'production';
const allowHeaderEmail = process.env.NODE_ENV === 'development' && process.env.ALLOW_HEADER_EMAIL === 'true';
const debugEndpointsEnabled = !isProd && process.env.ENABLE_DEBUG_ENDPOINTS === 'true';

logger.info({
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION || 'unset',
    mode: isProd ? 'production' : 'development',
}, 'Starting BigQuery Agent server');

const app = express();

// Trust proxy - required for Cloud Run (runs behind load balancer)
// This allows Express to properly handle X-Forwarded-For headers
app.set('trust proxy', 1);

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info({ method: req.method, url: req.url, status: res.statusCode, duration }, 'request');
    });
    next();
});

// CORS — only needed in development (Vite dev server on different port).
// In production, Express serves both the frontend and API on the same origin.
if (!isProd) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'];
    app.use(cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true); // curl, etc.
            if (allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        credentials: true
    }));
}

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: isProd ? 100 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const agentLimiter = isProd
    ? rateLimit({
        windowMs: 60 * 1000,
        max: parseInt(process.env.AGENT_RATE_LIMIT || '100', 10),
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many agent requests, please slow down.' }
    })
    : (req: any, res: any, next: any) => next();

// JSON parsing only for API routes
app.use('/api', express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT || '8080', 10);

// Error handlers
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
});

// --- API Endpoints for Chat History ---
app.use('/api', apiLimiter);

// Cache token -> email (keyed by token)
const tokenEmailCache = new LRUCache<string, { email: string; exp: number }>({
    max: 1000,
});

// Cache email -> runner (keyed by email for token rotation resilience)
const runnerCache = new LRUCache<string, CachedRunner>({
    max: 100,
    ttl: 1000 * 60 * 30, // 30 minute TTL
});

async function resolveEmailFromRequest(req: express.Request): Promise<string | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) return null;

    const cached = tokenEmailCache.get(token);
    if (cached && cached.exp > Date.now() + 60_000) {
        return cached.email;
    }

    try {
        const authClient = new OAuth2Client();
        const tokenInfo = await authClient.getTokenInfo(token);
        if (tokenInfo.email) {
            tokenEmailCache.set(token, { email: tokenInfo.email, exp: tokenInfo.expiry_date });
            return tokenInfo.email;
        }
    } catch (err) {
        logger.warn({ err }, 'Failed to resolve email from token');
    }
    if (allowHeaderEmail) {
        const headerEmail = req.headers['x-user-email'];
        if (typeof headerEmail === 'string' && headerEmail.includes('@')) {
            return headerEmail;
        }
    }
    return null;
}

async function requireUser(req: express.Request, res: express.Response) {
    const userEmail = await resolveEmailFromRequest(req);
    if (!userEmail) {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
    }
    const user = await historyService.ensureUser(userEmail);
    return { userEmail, user };
}

// List threads for a user
app.get('/api/threads', async (req, res) => {
    const authContext = await requireUser(req, res);
    if (!authContext) return;
    const { userEmail, user } = authContext;
    const requestedUser = req.query.userId as string | undefined;
    if (requestedUser && requestedUser !== userEmail && requestedUser !== user.id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    try {
        const threads = await historyService.getUserThreads(user.id);
        res.json(threads);
    } catch (error) {
        logger.error({ err: error }, 'Error fetching threads');
        res.status(500).json({ error: 'Failed to fetch threads' });
    }
});

// List threads for current user via Authorization header
app.get('/api/threads/me', async (req, res) => {
    try {
        const authContext = await requireUser(req, res);
        if (!authContext) return;
        const { userEmail, user } = authContext;
        const threads = await historyService.getUserThreads(user.id);
        res.json({ email: userEmail, threads });
    } catch (error) {
        logger.error({ err: error }, 'Error fetching threads for user');
        res.status(500).json({ error: 'Failed to fetch threads' });
    }
});

// Get messages for a thread
app.get('/api/threads/:threadId', async (req, res) => {
    const authContext = await requireUser(req, res);
    if (!authContext) return;
    const { user } = authContext;
    const { threadId } = req.params;
    const result_limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const limit = isNaN(result_limit) ? 100 : result_limit;
    try {
        const thread = await historyService.getThread(threadId);
        if (!thread) {
            res.status(404).json({ error: 'Thread not found' });
            return;
        }
        if (thread.userId !== user.id) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        const messages = await historyService.getThreadMessages(threadId, limit);
        res.json(messages);
    } catch (error) {
        logger.error({ err: error }, 'Error fetching messages');
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// Create a new thread
app.post('/api/threads', async (req, res) => {
    const authContext = await requireUser(req, res);
    if (!authContext) return;
    const { userEmail, user } = authContext;
    const { userId, title } = req.body || {};
    if (userId && userId !== userEmail && userId !== user.id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
    }
    try {
        const thread = await historyService.createThread(user.id, title);
        res.json(thread);
    } catch (error) {
        logger.error({ err: error }, 'Error creating thread');
        res.status(500).json({ error: 'Failed to create thread' });
    }
});

// Delete a thread
app.delete('/api/threads/:threadId', async (req, res) => {
    const authContext = await requireUser(req, res);
    if (!authContext) return;
    const { user } = authContext;
    const { threadId } = req.params;
    try {
        const thread = await historyService.getThread(threadId);
        if (!thread) {
            res.status(404).json({ error: 'Thread not found' });
            return;
        }
        if (thread.userId !== user.id) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        await historyService.deleteThread(threadId);
        res.json({ success: true });
    } catch (error) {
        logger.error({ err: error }, 'Error deleting thread');
        res.status(500).json({ error: 'Failed to delete thread' });
    }
});

// --- ADK Session Management ---
// Use DB-backed sessions for scale-to-zero support on Cloud Run.
// Falls back gracefully if DB is unavailable (events lost on restart).
const sessionService = new DbSessionService(prisma);

// Debug event capture (bounded LRU)
const debugEventStore = new LRUCache<string, BaseEvent[]>({
    max: 50,
    ttl: 1000 * 60 * 30, // 30 min TTL
});
const MAX_DEBUG_EVENTS = 500;

function recordDebugEvent(threadId: string, event: BaseEvent) {
    const list = debugEventStore.get(threadId) ?? [];
    list.push(event);
    if (list.length > MAX_DEBUG_EVENTS) {
        list.splice(0, list.length - MAX_DEBUG_EVENTS);
    }
    debugEventStore.set(threadId, list);
}

// Store runners and their log handlers
interface CachedRunner {
    runner: Runner;
    setLogHandler: (handler: (msg: string) => void) => void;
}

/**
 * Get or create a runner keyed by email.
 * If email is unknown (no token), falls back to '__default__'.
 * The authToken is still passed to createRootAgent for BigQuery user-level auth.
 */
async function getOrCreateRunner(authToken?: string): Promise<CachedRunner> {
    let cacheKey = '__default__';

    if (authToken) {
        // Try to resolve email from token cache first (fast path)
        const cached = tokenEmailCache.get(authToken);
        if (cached?.email) {
            cacheKey = cached.email;
        } else {
            // Slow path: verify token to get email
            try {
                const authClient = new OAuth2Client();
                const tokenInfo = await authClient.getTokenInfo(authToken);
                if (tokenInfo.email) {
                    cacheKey = tokenInfo.email;
                    tokenEmailCache.set(authToken, { email: tokenInfo.email, exp: tokenInfo.expiry_date });
                }
            } catch {
                // Token verification failed — use token hash as fallback
                cacheKey = `token:${authToken.slice(-8)}`;
            }
        }
    }

    if (runnerCache.has(cacheKey)) {
        return runnerCache.get(cacheKey)!;
    }

    const { agent, setLogHandler } = createRootAgent(authToken);

    const runner = new Runner({
        appName: config.branding.appName.replace(/\s+/g, '-').toLowerCase(),
        agent,
        sessionService,
    });

    const cached = { runner, setLogHandler };
    runnerCache.set(cacheKey, cached);
    logger.info({ cacheKey, cacheSize: runnerCache.size }, 'Created new runner for user');

    return cached;
}

// --- CopilotKit Runtime Setup ---
const runnerFactory = {
    getOrCreateRunner: (authToken?: string) => getOrCreateRunner(authToken),
};

const adkAgent = new AgUiAdkAgent(
    config as any,
    historyService,
    runnerFactory,
    sessionService
);

// Subscribe to capture AG-UI events per thread for debug inspection
adkAgent.subscribe({
    onEvent: ({ event, input }) => {
        const threadId = input?.threadId || 'unknown';
        recordDebugEvent(threadId, event as BaseEvent);
    }
});

class HybridAgentRunner extends InMemoryAgentRunner {
    constructor(private defaultAgent: AbstractAgent) {
        super();
    }

    connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
        const memory$ = super.connect(request);
        const db$ = this.defaultAgent.connect({ threadId: request.threadId } as any);

        return new Observable<BaseEvent>((subscriber) => {
            const seenMessageIds = new Set<string>();
            const seenToolCallIds = new Set<string>();
            let memSub: Subscription | null = null;

            const recordSnapshot = (messages: any[]) => {
                for (const msg of messages) {
                    if (msg?.id) seenMessageIds.add(msg.id);
                    if (msg?.role === 'assistant' && Array.isArray(msg.toolCalls)) {
                        for (const toolCall of msg.toolCalls) {
                            if (toolCall?.id) seenToolCallIds.add(toolCall.id);
                        }
                    }
                    if (msg?.role === 'tool' && msg.toolCallId) {
                        seenToolCallIds.add(msg.toolCallId);
                    }
                }
            };

            const recordEventIds = (event: any) => {
                if (event?.messageId && typeof event.messageId === 'string') seenMessageIds.add(event.messageId);
                if (event?.toolCallId && typeof event.toolCallId === 'string') seenToolCallIds.add(event.toolCallId);
            };

            const shouldSkipEvent = (event: any) => {
                if (event?.messageId && seenMessageIds.has(event.messageId)) return true;
                if (event?.toolCallId && seenToolCallIds.has(event.toolCallId)) return true;
                return false;
            };

            const dbSub = db$.subscribe({
                next: (event) => {
                    if (event.type === EventType.MESSAGES_SNAPSHOT) {
                        recordSnapshot((event as any).messages ?? []);
                    }
                    recordEventIds(event as any);
                    subscriber.next(event);
                },
                error: (err) => subscriber.error(err),
                complete: () => {
                    super
                        .isRunning(request)
                        .then((isRunning) => {
                            if (!isRunning) {
                                subscriber.complete();
                                return;
                            }
                            memSub = memory$.subscribe({
                                next: (event) => {
                                    if (shouldSkipEvent(event as any)) return;
                                    recordEventIds(event as any);
                                    subscriber.next(event);
                                },
                                error: (err) => subscriber.error(err),
                                complete: () => subscriber.complete(),
                            });
                        })
                        .catch((err) => subscriber.error(err));
                },
            });

            return () => {
                dbSub.unsubscribe();
                if (memSub) memSub.unsubscribe();
            };
        });
    }
}

const copilotKit = new CopilotRuntime({
    agents: {
        'default': adkAgent
    },
    runner: new HybridAgentRunner(adkAgent),
});

const handler = copilotRuntimeNodeHttpEndpoint({
    endpoint: '/',
    runtime: copilotKit,
    serviceAdapter: new DummyAdapter() as any,
});

// Custom /copilotkit/info handler
app.all('/copilotkit/info', (req, res) => {
    const agentName = 'default';
    const description =
        (adkAgent as any)?.description ||
        config?.agent?.orchestrator?.role ||
        'ADK Agent';
    res.json({
        version: process.env.COPILOTKIT_VERSION || 'unknown',
        agents: {
            [agentName]: {
                name: agentName,
                description,
                className: adkAgent.constructor?.name || 'AdkAgent'
            }
        },
        audioFileTranscriptionEnabled: false
    });
});

// Standard CopilotKit Handler
app.use('/copilotkit', agentLimiter, (req, res, next) => {
    return handler(req, res);
});

// Debug endpoints (dev only)
if (debugEndpointsEnabled) {
    app.get('/api/debug/events/:threadId', (req, res) => {
        const threadId = req.params.threadId;
        const full = req.query.full === '1';
        const events = debugEventStore.get(threadId) ?? [];
        const payload = full
            ? events
            : events.map((event) => {
                if (event.type === EventType.TOOL_CALL_ARGS) {
                    return { ...event, delta: typeof (event as any).delta === 'string' ? (event as any).delta.slice(0, 500) : (event as any).delta };
                }
                if (event.type === EventType.TOOL_CALL_RESULT) {
                    return { ...event, content: typeof (event as any).content === 'string' ? (event as any).content.slice(0, 500) : (event as any).content };
                }
                if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
                    return { ...event, delta: typeof (event as any).delta === 'string' ? (event as any).delta.slice(0, 500) : (event as any).delta };
                }
                return event;
            });
        res.json({ threadId, count: events.length, events: payload });
    });

    app.get('/api/debug/tool-events/:threadId', (req, res) => {
        const threadId = req.params.threadId;
        const full = req.query.full === '1';
        const events = (debugEventStore.get(threadId) ?? []).filter((event) =>
            event.type === EventType.TOOL_CALL_START ||
            event.type === EventType.TOOL_CALL_ARGS ||
            event.type === EventType.TOOL_CALL_END ||
            event.type === EventType.TOOL_CALL_RESULT
        );
        const payload = full
            ? events
            : events.map((event) => {
                if (event.type === EventType.TOOL_CALL_ARGS) {
                    return { ...event, delta: typeof (event as any).delta === 'string' ? (event as any).delta.slice(0, 500) : (event as any).delta };
                }
                if (event.type === EventType.TOOL_CALL_RESULT) {
                    return { ...event, content: typeof (event as any).content === 'string' ? (event as any).content.slice(0, 500) : (event as any).content };
                }
                return event;
            });
        res.json({ threadId, count: events.length, events: payload });
    });
}

// --- Static File Serving (Production) ---
// In production, Express serves the Vite-built client from /app/client/dist.
// Note: In the bundled code, __dirname is /app/dist, so we need to go up one level.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = isProd
    ? path.resolve(__dirname, '..', 'client', 'dist')
    : path.resolve(__dirname, 'client', 'dist');

if (isProd) {
    app.use(express.static(clientDistPath, {
        maxAge: '1d',
        etag: true,
        index: false, // We handle index.html via the SPA fallback below
    }));
}

// Health check
app.get('/health', async (req, res) => {
    const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DB check timeout')), 3000)
    );
    try {
        await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
        res.json({
            status: 'ok',
            mode: 'ADK',
            db: 'connected'
        });
    } catch (error) {
        logger.error({ err: error }, 'Health check failed');
        // Return 200 with degraded status to avoid Cloud Run removing the instance on transient DB issues
        res.json({
            status: 'degraded',
            mode: 'ADK',
            db: 'disconnected'
        });
    }
});

// SPA fallback — serve index.html for any non-API, non-asset route
if (isProd) {
    app.get(/.*/, (req, res) => {
        res.sendFile(path.join(clientDistPath, 'index.html'));
    });
}

app.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'Server listening');
});
