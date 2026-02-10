import React from 'react';

const brandName = import.meta.env.VITE_APP_BRAND_NAME || "Data Assistant";

interface Thread {
    id: string;
    title: string | null;
    updatedAt: string;
    _count: {
        messages: number;
    }
}

interface SidebarProps {
    userId: string | null;
    activeThreadId: string | null;
    threads: Thread[];
    loading: boolean;
    disableActions?: boolean;
    onSelectThread: (threadId: string) => void;
    onNewChat: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ userId, activeThreadId, threads, loading, disableActions, onSelectThread, onNewChat }) => {
    return (
        <aside className="sidebar">
            <div className="sidebar-header">
                <div className="brand-icon" />
                <span className="brand-text">{brandName}</span>
            </div>

            <button
                onClick={onNewChat}
                className="new-chat-btn"
                disabled={!!disableActions}
                aria-disabled={!!disableActions}
            >
                <span>+</span> New Chat
            </button>

            <h3 className="history-label">History</h3>

            <div className="history-list">
                {loading && threads.length === 0 && (
                    <div style={{ padding: '8px', color: '#94a3b8', fontSize: '0.9rem' }}>Loading...</div>
                )}

                {threads.map(thread => (
                    <div
                        key={thread.id}
                        onClick={() => onSelectThread(thread.id)}
                        className={`history-item ${activeThreadId === thread.id ? 'active' : ''}`}
                    >
                        {thread.title || 'Untitled Chat'}
                    </div>
                ))}
            </div>

            <div className="sidebar-footer">
                <div className="user-info">
                    {userId ? `Logged in as ${userId.split('@')[0]}` : 'Guest User'}
                </div>
            </div>
        </aside>
    );
};
