import { PrismaClient } from '@prisma/client';
import { BaseSessionService } from '@google/adk';
import type {
    CreateSessionRequest,
    GetSessionRequest,
    ListSessionsRequest,
    ListSessionsResponse,
    DeleteSessionRequest,
} from '@google/adk';
import type { Session } from '@google/adk';
import type { Event } from '@google/adk';
import { logger } from '../lib/logger.ts';

/**
 * DB-backed SessionService using Prisma/PostgreSQL.
 * Enables Cloud Run scale-to-zero by persisting ADK sessions to the database.
 *
 * Architecture notes:
 * - Sessions map 1:1 with chat threads (sessionId = threadId)
 * - Events are stored as serialized JSON in AdkSessionEvent rows
 * - State is stored as JSON in the AdkSession row
 * - appendEvent is inherited from BaseSessionService (handles state delta merging),
 *   then we persist the event + updated state to DB
 */
export class DbSessionService extends BaseSessionService {
    constructor(private prisma: PrismaClient) {
        super();
    }

    async createSession(request: CreateSessionRequest): Promise<Session> {
        const sessionId = request.sessionId || crypto.randomUUID();
        const state = request.state || {};

        try {
            await this.prisma.adkSession.create({
                data: {
                    id: sessionId,
                    appName: request.appName,
                    userId: request.userId,
                    state: state as any,
                },
            });
        } catch (err: any) {
            // Handle duplicate key — session already exists (concurrent creation)
            if (err?.code === 'P2002') {
                logger.warn({ sessionId }, '[DbSessionService] Session already exists, returning existing');
                const existing = await this.getSession({
                    appName: request.appName,
                    userId: request.userId,
                    sessionId,
                });
                if (existing) return existing;
            }
            throw err;
        }

        const session: Session = {
            id: sessionId,
            appName: request.appName,
            userId: request.userId,
            state,
            events: [],
            lastUpdateTime: Date.now(),
        };

        logger.info({ sessionId, appName: request.appName }, '[DbSessionService] Created session');
        return session;
    }

    async getSession(request: GetSessionRequest): Promise<Session | undefined> {
        const dbSession = await this.prisma.adkSession.findUnique({
            where: { id: request.sessionId },
            include: {
                events: {
                    orderBy: { timestamp: 'asc' },
                    ...(request.config?.numRecentEvents
                        ? { take: request.config.numRecentEvents, orderBy: { timestamp: 'desc' as const } }
                        : {}),
                    ...(request.config?.afterTimestamp
                        ? { where: { timestamp: { gt: new Date(request.config.afterTimestamp) } } }
                        : {}),
                },
            },
        });

        if (!dbSession) return undefined;

        // Reconstruct ADK Event objects from stored JSON
        let events: Event[] = dbSession.events.map((e) => e.eventData as unknown as Event);

        // If we fetched with numRecentEvents (desc order), reverse to chronological
        if (request.config?.numRecentEvents) {
            events = events.reverse();
        }

        const session: Session = {
            id: dbSession.id,
            appName: dbSession.appName,
            userId: dbSession.userId,
            state: (dbSession.state as Record<string, unknown>) || {},
            events,
            lastUpdateTime: dbSession.lastUpdateTime.getTime(),
        };

        return session;
    }

    async listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
        const dbSessions = await this.prisma.adkSession.findMany({
            where: {
                appName: request.appName,
                userId: request.userId,
            },
            orderBy: { lastUpdateTime: 'desc' },
        });

        const sessions: Session[] = dbSessions.map((s) => ({
            id: s.id,
            appName: s.appName,
            userId: s.userId,
            state: {},
            events: [], // Per ADK convention: listSessions does not include events/state
            lastUpdateTime: s.lastUpdateTime.getTime(),
        }));

        return { sessions };
    }

    async deleteSession(request: DeleteSessionRequest): Promise<void> {
        await this.prisma.adkSession.delete({
            where: { id: request.sessionId },
        }).catch((err: any) => {
            // Ignore if session doesn't exist
            if (err?.code === 'P2025') {
                logger.warn({ sessionId: request.sessionId }, '[DbSessionService] Session not found for deletion');
                return;
            }
            throw err;
        });

        logger.info({ sessionId: request.sessionId }, '[DbSessionService] Deleted session');
    }

    /**
     * Override appendEvent to persist to DB after the base class processes state deltas.
     */
    override async appendEvent({ session, event }: { session: Session; event: Event }): Promise<Event> {
        // Let the base class handle state delta merging and event ID assignment
        const processedEvent = await super.appendEvent({ session, event });

        // Persist event and updated state to DB
        try {
            await this.prisma.$transaction([
                this.prisma.adkSessionEvent.create({
                    data: {
                        sessionId: session.id,
                        eventData: processedEvent as any,
                        invocationId: processedEvent.invocationId || null,
                        author: processedEvent.author || null,
                        timestamp: new Date(processedEvent.timestamp || Date.now()),
                    },
                }),
                this.prisma.adkSession.update({
                    where: { id: session.id },
                    data: {
                        state: session.state as any,
                    },
                }),
            ]);
        } catch (err) {
            logger.error({ err, sessionId: session.id, eventId: processedEvent.id }, '[DbSessionService] Failed to persist event');
            // Don't throw — the in-memory session already has the event.
            // On restart, the session will be re-loaded from DB (missing this event).
            // This is acceptable for our use case vs. crashing the request.
        }

        return processedEvent;
    }
}
