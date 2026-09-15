import { classNames } from '../../shared/controls/logic.js';
import {
  attachmentBadge,
  messageMetaParts,
  toolCallCapSummary,
  toolCallNames,
  type AttachmentView,
  type ChatMessage,
} from './chatThread.js';
import { renderMarkdown } from './markdown.js';
import { ThoughtTrace } from './ThoughtTrace.js';

export interface ChatMessageBlockProps {
  message: ChatMessage;
  attachmentStart: number;
  onOpenAttachment: (attachment: AttachmentView) => void;
}

const fromLabels: Record<ChatMessage['role'], string> = {
  user: 'You',
  assistant: 'Assistant',
  system: 'System',
};

function roleClass(message: ChatMessage): string {
  if (message.role === 'user') return 'user';
  if (message.role === 'assistant') return 'model';
  return 'system';
}

export function ChatMessageBlock({
  message,
  attachmentStart,
  onOpenAttachment,
}: ChatMessageBlockProps) {
  const metaParts = messageMetaParts(message);
  const names = toolCallNames(message);
  const cap = message.toolCalls === null ? null : toolCallCapSummary(names);
  return (
    <div
      className={classNames('msg', roleClass(message))}
      data-testid={`msg-${String(message.index)}`}
    >
      <div className="mh">
        <span
          className={classNames('from', message.role === 'assistant' && 'acc')}
        >
          {fromLabels[message.role]}
        </span>
      </div>
      <div className="mc">
        {message.role !== 'user' && message.thought !== null && (
          <ThoughtTrace
            text={message.thought}
            defaultExpanded={false}
            testId={`msg-thought-${String(message.index)}`}
          />
        )}
        {message.role === 'user' ? (
          <p>{message.text}</p>
        ) : (
          <div
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }}
          />
        )}
        {message.attachments.map((attachment, offset) => {
          const index = attachmentStart + offset;
          return (
            <button
              className="att"
              key={`${String(index)}`}
              type="button"
              data-testid={`attachment-chip-${String(index)}`}
              title="Open in editor"
              onClick={() => {
                onOpenAttachment(attachment);
              }}
            >
              <span className="ext">{attachmentBadge(attachment.kind)}</span>
              <span>
                <b>{attachment.label}</b>
                {attachment.id === null ? '' : ` · ${attachment.id}`}
              </span>
              <span className="caret">edit →</span>
            </button>
          );
        })}
      </div>
      <p className="mmeta" data-testid={`msg-meta-${String(message.index)}`}>
        {metaParts.length > 0 && (
          <span className="mono">{metaParts.join(' · ')}</span>
        )}
        {cap !== null && (
          <span
            className="mono tc"
            data-testid={`toolcap-${String(message.index)}`}
            title={names.join(', ')}
          >
            {cap.text}
          </span>
        )}
      </p>
    </div>
  );
}
