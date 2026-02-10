import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for DbSessionService.
 * Uses a mocked Prisma client to verify DB operations without requiring a real database.
 */

// Mock the logger to prevent pino initialization issues in test
vi.mock('../lib/logger.ts', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
    },
}));

// Dynamically import after mocks are set up
const { DbSessionService } = await import('../services/db-session-service.ts');

function createMockPrisma() {
    return {
        adkSession: {
            create: vi.fn(),
            findUnique: vi.fn(),
            findMany: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
        },
        adkSessionEvent: {
            create: vi.fn(),
        },
        $transaction: vi.fn(),
    };
}

describe('DbSessionService', () => {
    let prisma: ReturnType<typeof createMockPrisma>;
    let service: InstanceType<typeof DbSessionService>;

    beforeEach(() => {
        prisma = createMockPrisma();
        service = new DbSessionService(prisma as any);
    });

    describe('createSession', () => {
        it('creates a session and returns it', async () => {
            prisma.adkSession.create.mockResolvedValue({});

            const session = await service.createSession({
                appName: 'test-app',
                userId: 'user@test.com',
                sessionId: 'session-123',
            });

            expect(session.id).toBe('session-123');
            expect(session.appName).toBe('test-app');
            expect(session.userId).toBe('user@test.com');
            expect(session.events).toEqual([]);
            expect(session.state).toEqual({});
            expect(prisma.adkSession.create).toHaveBeenCalledWith({
                data: {
                    id: 'session-123',
                    appName: 'test-app',
                    userId: 'user@test.com',
                    state: {},
                },
            });
        });

        it('handles duplicate key error gracefully', async () => {
            prisma.adkSession.create.mockRejectedValue({ code: 'P2002' });
            prisma.adkSession.findUnique.mockResolvedValue({
                id: 'session-123',
                appName: 'test-app',
                userId: 'user@test.com',
                state: {},
                lastUpdateTime: new Date(),
                events: [],
            });

            const session = await service.createSession({
                appName: 'test-app',
                userId: 'user@test.com',
                sessionId: 'session-123',
            });

            expect(session.id).toBe('session-123');
        });
    });

    describe('getSession', () => {
        it('returns undefined when session not found', async () => {
            prisma.adkSession.findUnique.mockResolvedValue(null);

            const result = await service.getSession({
                appName: 'test-app',
                userId: 'user@test.com',
                sessionId: 'nonexistent',
            });

            expect(result).toBeUndefined();
        });

        it('reconstructs session with events from DB', async () => {
            const mockEvent = {
                id: 'evt-1',
                invocationId: 'inv-1',
                author: 'user',
                content: { role: 'user', parts: [{ text: 'Hello' }] },
                actions: { stateDelta: {}, artifactDelta: {}, requestedAuthConfigs: {} },
                timestamp: Date.now(),
            };

            prisma.adkSession.findUnique.mockResolvedValue({
                id: 'session-123',
                appName: 'test-app',
                userId: 'user@test.com',
                state: { key: 'value' },
                lastUpdateTime: new Date(),
                events: [{ eventData: mockEvent, timestamp: new Date() }],
            });

            const session = await service.getSession({
                appName: 'test-app',
                userId: 'user@test.com',
                sessionId: 'session-123',
            });

            expect(session).toBeDefined();
            expect(session!.id).toBe('session-123');
            expect(session!.state).toEqual({ key: 'value' });
            expect(session!.events).toHaveLength(1);
            expect(session!.events[0]).toEqual(mockEvent);
        });
    });

    describe('listSessions', () => {
        it('returns sessions without events/state', async () => {
            prisma.adkSession.findMany.mockResolvedValue([
                {
                    id: 'session-1',
                    appName: 'test-app',
                    userId: 'user@test.com',
                    lastUpdateTime: new Date(),
                },
                {
                    id: 'session-2',
                    appName: 'test-app',
                    userId: 'user@test.com',
                    lastUpdateTime: new Date(),
                },
            ]);

            const result = await service.listSessions({
                appName: 'test-app',
                userId: 'user@test.com',
            });

            expect(result.sessions).toHaveLength(2);
            expect(result.sessions[0].events).toEqual([]);
            expect(result.sessions[0].state).toEqual({});
        });
    });

    describe('deleteSession', () => {
        it('deletes session successfully', async () => {
            prisma.adkSession.delete.mockResolvedValue({});

            await service.deleteSession({
                appName: 'test-app',
                userId: 'user@test.com',
                sessionId: 'session-123',
            });

            expect(prisma.adkSession.delete).toHaveBeenCalledWith({
                where: { id: 'session-123' },
            });
        });

        it('handles not found error gracefully', async () => {
            prisma.adkSession.delete.mockRejectedValue({ code: 'P2025' });

            // Should not throw
            await service.deleteSession({
                appName: 'test-app',
                userId: 'user@test.com',
                sessionId: 'nonexistent',
            });
        });
    });
});
