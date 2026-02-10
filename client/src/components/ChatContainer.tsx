import React from 'react';
import { CopilotChat } from '@copilotkit/react-ui';
import { ToolAwareMessage } from './ToolAwareMessage';

// Import config for branding
// Note: In production, you might want to load this via an API call
// or use Vite's import.meta.env for build-time configuration
const chatConfig = {
    title: import.meta.env.VITE_APP_CHAT_TITLE || "Data Assistant",
    initialMessage: import.meta.env.VITE_APP_CHAT_INITIAL || "Hello! I'm your Data Assistant. Ask me questions about your data.",
};

export const ChatContainer: React.FC = () => {
    return (
        <CopilotChat
            className="copilot-chat-container"
            labels={{
                title: chatConfig.title,
                initial: chatConfig.initialMessage,
            }}
            RenderMessage={ToolAwareMessage}
        />
    );
};
