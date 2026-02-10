import { BaseEvent } from '@ag-ui/client';

export interface UserContext {
    id: string;
    email: string;
}

export interface ThreadContext {
    id: string;
    title: string | null;
    userId: string;
    createdAt: Date;
}

/**
 * Interface for history service dependencies required by the adapter.
 * This allows the adapter to be agnostic of the actual database implementation.
 */
export interface HistoryServiceAdapter {
    ensureUser(email: string): Promise<UserContext>;
    getUserThreads(userId: string): Promise<ThreadContext[]>;
    getThread(threadId: string): Promise<ThreadContext | null>;
    createThread(userId: string, title: string, threadId?: string): Promise<ThreadContext>;
    addMessage(threadId: string, role: string, content: string): Promise<any>;
    getThreadMessages(threadId: string, limit?: number): Promise<any[]>;
    updateThreadTitle(threadId: string, title: string): Promise<any>;
    addToolMessage(threadId: string, type: string, content: string, metadata?: any): Promise<any>;
}

/**
 * Configuration for the ADK Adapter
 */
export interface AdkAdapterConfig {
    agent: {
        orchestrator: {
            name: string;
            domain?: string;
            role?: string;
        };
    };
    branding: {
        appName: string;
    };
}

/**
 * Interface for the Runner factory
 */
export interface RunnerFactory {
    getOrCreateRunner(authToken?: string): Promise<{ runner: any; setLogHandler: (handler: (msg: string) => void) => void }> | { runner: any; setLogHandler: (handler: (msg: string) => void) => void };
}

/**
 * Interface for the Session service
 */
export interface SessionServiceAdapter {
    getSession(context: { appName: string; userId: string; sessionId: string; }): Promise<any>;
    createSession(context: { appName: string; userId: string; sessionId: string; }): Promise<any>;
    appendEvent(context: { session: any; event: any; }): Promise<any>;
}
