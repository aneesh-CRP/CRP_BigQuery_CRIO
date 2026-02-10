import React from "react";
import type { RenderMessageProps } from "@copilotkit/react-ui";
import { AssistantMessage, UserMessage, ImageRenderer } from "@copilotkit/react-ui";

type ToolCall = {
  id: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
};

const safeParseArgs = (args: ToolCall["function"]["arguments"]) => {
  if (!args) return undefined;
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof args === "object") return args as Record<string, unknown>;
  return undefined;
};

const ToolCallCard: React.FC<{ toolCall: ToolCall }> = ({ toolCall }) => {
  const parsedArgs = safeParseArgs(toolCall.function.arguments);
  const argsObj =
    parsedArgs && typeof parsedArgs === "object" ? (parsedArgs as Record<string, unknown>) : undefined;
  const query =
    typeof parsedArgs === "string"
      ? parsedArgs
      : argsObj && typeof argsObj.query === "string"
        ? (argsObj.query as string)
        : undefined;

  const argsText = query
    ? query
    : argsObj
      ? JSON.stringify(argsObj, null, 2)
      : typeof toolCall.function.arguments === "string"
        ? toolCall.function.arguments
        : "";

  return (
    <div className="tool-call-card">
      <div className="tool-call-header">
        <span className="tool-call-label">Tool Call</span>
        <span className="tool-call-name">{toolCall.function.name}</span>
      </div>
      {argsText ? (
        <details className="tool-call-details">
          <summary className="tool-call-summary">
            {query ? "SQL query (expand)" : "Arguments (expand)"}
          </summary>
          <pre className="tool-call-args">
            <code>{argsText}</code>
          </pre>
        </details>
      ) : (
        <div className="tool-call-empty">No arguments provided.</div>
      )}
    </div>
  );
};

const stripLegacyToolBlocks = (content: string) => {
  if (!content) return content;
  let output = content;

  // Remove legacy tool call markdown injected into assistant content
  output = output.replace(/\n?>\s*🛠️\s*\*\*Tool Call\*\*:[^\n]*\n?/g, "\n");
  output = output.replace(/\n?>\s*📋\s*\*\*Listing Database Tables\*\*.*\n?/g, "\n");
  output = output.replace(/\n?>\s*🛠️\s*\*\*Finding Schema:\*\*[^\n]*\n?/g, "\n");
  output = output.replace(/\n?>\s*📊\s*\*\*Executing SQL:\*\*\n```sql[\s\S]*?```\n?/g, "\n");

  // Normalize extra spacing
  output = output.replace(/\n{3,}/g, "\n\n");
  return output.trim();
};

export const ToolAwareMessage: React.FC<RenderMessageProps> = (props) => {
  const {
    message,
    messages,
    inProgress,
    index,
    isCurrentMessage,
    onRegenerate,
    onCopy,
    onThumbsUp,
    onThumbsDown,
    messageFeedback,
    markdownTagRenderers,
  } = props;

  const Assistant = props.AssistantMessage ?? AssistantMessage;
  const User = props.UserMessage ?? UserMessage;
  const Img = props.ImageRenderer ?? ImageRenderer;

  if (message.role === "user") {
    return (
      <User
        key={index}
        rawData={message}
        message={message as any}
        ImageRenderer={Img}
      />
    );
  }

  if (message.role === "assistant") {
    const toolCalls =
      ((message as any).toolCalls as ToolCall[] | undefined) ||
      ((message as any).tool_calls as ToolCall[] | undefined);
    const rawContent =
      typeof (message as any).content === "string"
        ? ((message as any).content as string)
        : "";
    const sanitizedContent = stripLegacyToolBlocks(rawContent);
    const hasContent = sanitizedContent.trim().length > 0;
    const sanitizedMessage = {
      ...(message as any),
      content: sanitizedContent,
    };
    return (
      <>
        {toolCalls?.map((toolCall) => (
          <ToolCallCard key={toolCall.id} toolCall={toolCall} />
        ))}
        {hasContent ? (
          <Assistant
            key={index}
            rawData={message}
            message={sanitizedMessage as any}
            messages={messages}
            isLoading={inProgress && isCurrentMessage && !message.content}
            isGenerating={inProgress && isCurrentMessage && !!message.content}
            isCurrentMessage={isCurrentMessage}
            onRegenerate={() => onRegenerate?.(message.id)}
            onCopy={onCopy}
            onThumbsUp={onThumbsUp}
            onThumbsDown={onThumbsDown}
            feedback={messageFeedback?.[message.id] || null}
            markdownTagRenderers={markdownTagRenderers}
            ImageRenderer={Img}
            subComponent={message.generativeUI?.()}
          />
        ) : null}
      </>
    );
  }

  return null;
};
