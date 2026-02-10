import { prisma } from '../db.ts';

export class HistoryService {
    // Ensure a user exists by email
    async ensureUser(email: string) {
        return prisma.user.upsert({
            where: { email },
            update: {},
            create: { email },
        });
    }

    // LIST threads for a user (by userId, not email, to save lookups)
    async getUserThreads(userId: string) {
        return prisma.thread.findMany({
            where: { userId },
            orderBy: { updatedAt: 'desc' },
            include: {
                _count: {
                    select: { messages: true }
                }
            }
        });
    }

    // GET full history for a thread (Paginated)
    async getThreadMessages(threadId: string, limit = 100) {
        return prisma.message.findMany({
            where: { threadId },
            orderBy: { createdAt: 'asc' },
            take: -limit // Take last N messages
        });
    }

    // GET a single thread by ID
    async getThread(threadId: string) {
        return prisma.thread.findUnique({
            where: { id: threadId },
            include: {
                _count: {
                    select: { messages: true }
                }
            }
        });
    }

    // CREATE a new thread
    async createThread(userId: string, title?: string, id?: string) {
        return prisma.thread.create({
            data: {
                id: id,
                userId,
                title: title || 'New Chat',
            },
            include: {
                _count: {
                    select: { messages: true }
                }
            }
        });
    }

    // UPDATE thread title
    async updateThreadTitle(threadId: string, title: string) {
        return prisma.thread.update({
            where: { id: threadId },
            data: { title },
        });
    }

    // ADD a message to a thread
    async addMessage(threadId: string, role: string, content: string) {
        // Also update the thread's updatedAt timestamp
        const [message] = await prisma.$transaction([
            prisma.message.create({
                data: {
                    threadId,
                    role,
                    content,
                },
            }),
            prisma.thread.update({
                where: { id: threadId },
                data: { updatedAt: new Date() },
            }),
        ]);
        return message;
    }

    // DELETE a thread
    async deleteThread(threadId: string) {
        return prisma.thread.delete({
            where: { id: threadId },
        });
    }

    // ADD a tool call/result message with structured metadata
    async addToolMessage(
        threadId: string,
        type: 'tool_call' | 'tool_result' | 'sql_query',
        content: string,
        metadata: {
            name?: string;
            args?: Record<string, unknown>;
            result?: unknown;
            query?: string;
            error?: string;
            subagent?: string;
            source?: 'root' | 'subagent';
        }
    ) {
        const [message] = await prisma.$transaction([
            prisma.message.create({
                data: {
                    threadId,
                    role: 'tool',
                    type,
                    content,
                    metadata: metadata as any,
                },
            }),
            prisma.thread.update({
                where: { id: threadId },
                data: { updatedAt: new Date() },
            }),
        ]);
        return message;
    }
}

export const historyService = new HistoryService();

