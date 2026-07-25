import {
  Bot,
  Check,
  Copy,
  Edit3,
  RefreshCw,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import SourcesPanel from "./SourcesPanel.jsx";
import AttachmentCard from "./AttachmentCard.jsx";

function citationMarkdown(content, messageId) {
  return content.replace(/\[([A-Z]+\d+)\]/g, `[$1](#source-${messageId}-$1)`);
}

export default function ChatMessage({ message, onRetry, onRemove, onEdit, onQuestion, onAttachmentRetry, onAttachmentDelete }) {
  const [copied, setCopied] = useState(false);
  const [activeSource, setActiveSource] = useState(null);
  const isUser = message.role === "user";
  const markdown = useMemo(
    () => citationMarkdown(message.content || "", message.id),
    [message.content, message.id],
  );

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  function markdownLink({ href, children }) {
    if (href?.startsWith(`#source-${message.id}-`)) {
      const sourceId = href.split("-").at(-1);
      return (
        <button
          type="button"
          className="inline-citation"
          onClick={() => {
            setActiveSource(sourceId);
            window.setTimeout(
              () =>
                document
                  .getElementById(`source-${message.id}-${sourceId}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "center" }),
              80,
            );
          }}
        >
          {children}
        </button>
      );
    }
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }

  return (
    <article
      className={`message-row ${isUser ? "message-row-user" : "message-row-assistant"}`}
    >
      {!isUser && (
        <div className="assistant-avatar">
          <Bot size={17} />
        </div>
      )}
      <div className={isUser ? "user-message-wrap" : "assistant-message-wrap"}>
        {!isUser && !message.localError && (
          <div className="assistant-identity">
            <span>MediSage</span>
            <span>Medical education assistant</span>
          </div>
        )}
        {message.safety?.requiresUrgentCare && message.safety.warning && (
          <div className="urgent-card" role="alert">
            <ShieldAlert size={19} />
            <div>
              <strong>Seek urgent care now</strong>
              <p>{message.safety.warning}</p>
            </div>
          </div>
        )}
        {(message.attachments || []).length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((attachment) => (
              <AttachmentCard
                key={attachment.id || attachment.localId}
                attachment={attachment}
                mode="sent"
                onRetry={onAttachmentRetry}
                onRemove={onAttachmentDelete}
              />
            ))}
          </div>
        )}
        {(!isUser || message.content) && <div
          className={
            isUser
              ? "user-bubble"
              : message.localError
                ? "error-card"
                : "assistant-content"
          }
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : message.localError ? (
            <div>
              <p>{message.content}</p>
              {message.retryable && (
                <button
                  type="button"
                  disabled={message.retrying}
                  onClick={() => onRetry?.(message)}
                  className="retry-button"
                >
                  <RefreshCw
                    size={14}
                    className={message.retrying ? "spin" : ""}
                  />
                  {message.retrying ? "Retrying…" : "Retry"}
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemove?.(message)}
                className="retry-button"
              >
                Remove
              </button>
            </div>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{ a: markdownLink }}
            >
              {markdown}
            </ReactMarkdown>
          )}
        </div>}
        {!isUser && !message.localError && (
          <SourcesPanel
            sources={message.sources}
            groundingType={message.groundingType}
            activeSource={activeSource}
            messageId={message.id}
          />
        )}
        {!isUser &&
          !message.localError &&
          message.relatedQuestions?.length > 0 && (
            <div className="related-questions">
              <p>Continue exploring</p>
              <div>
                {message.relatedQuestions.map((question) => (
                  <button
                    type="button"
                    key={question}
                    onClick={() => onQuestion?.(question)}
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          )}
        {(message.content || !isUser) && <div className={`message-actions ${isUser ? "justify-end" : ""}`}>
          <button type="button" onClick={copyMessage} className="micro-action">
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
          {isUser && (
            <button
              type="button"
              onClick={() => onEdit?.(message.content)}
              className="micro-action"
            >
              <Edit3 size={13} />
              Edit
            </button>
          )}
        </div>}
      </div>
      {isUser && (
        <div className="user-avatar">
          <UserRound size={16} />
        </div>
      )}
    </article>
  );
}
