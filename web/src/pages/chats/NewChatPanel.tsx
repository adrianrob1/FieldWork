import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { getJson } from '../../shared/api.js';
import { useKeyboardLift } from '../../shared/useKeyboardLift.js';
import {
  BackendPicker,
  FilterMenu,
  MentionPopup,
  MenuItem,
  ProjectMultiSelect,
  useMentionPicker,
  type OptionItem,
} from '../../shared/controls/index.js';
import { navigate, useRoute } from '../../shared/router.js';
import { PagePlaceholder, SheetPlaceholder } from '../stub.js';
import {
  hasMessageText,
  parseAttachables,
  type AttachableView,
} from '../draftFlow.js';
import { useStoredDraft } from '../useStoredDraft.js';

// The 05 start view: welcome copy, suggestion chips, and the growing composer
// with project / attachment / backend pickers. Extracted from NewChatPage so
// the dedicated /chats/new route and the embedded desktop /chats content pane
// render the exact same panel over the same stored-draft lifecycle.

const suggestions: readonly { label: string; text: string }[] = [
  {
    label: 'Draft the lab meeting agenda',
    text: "Draft the agenda for Thursday's lab meeting",
  },
  {
    label: 'Summarize the scaling notes',
    text: 'Summarize the scaling notes into three bullet points',
  },
  {
    label: 'Plan the next experiment batch',
    text: 'Plan the next experiment batch around the R12 runs',
  },
];

const attachableQuery =
  '/api/attachables?kinds=task,resource,summary,chat,project&limit=200';

function AttachmentPicker({
  onPick,
  disabled,
}: {
  onPick: (attachable: AttachableView) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [attachables, setAttachables] = useState<AttachableView[]>([]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void getJson<unknown>(attachableQuery).then((outcome) => {
      if (!active) return;
      setAttachables(outcome.ok ? parseAttachables(outcome.data) : []);
    });
    return () => {
      active = false;
    };
  }, [open]);

  const items: OptionItem[] = attachables.map((entry) => ({
    id: entry.id,
    label: entry.label,
    keywords: [entry.kind, entry.path],
  }));

  return (
    <FilterMenu
      items={items}
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Attach context"
      align="left"
      placeholder="Filter attachables"
      menuTestId="attachment-menu"
      emptyText="No attachables"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className="btn sm"
          data-testid="attachment-picker"
          disabled={disabled}
        >
          Attach <span className="ct">▾</span>
        </button>
      )}
      renderItem={(item) => {
        const attachable = attachables.find((entry) => entry.id === item.id);
        return (
          <MenuItem
            key={item.id}
            label={item.label}
            sublabel={attachable?.kind}
            testId={`attach-item-${item.id}`}
            onSelect={() => {
              if (attachable !== undefined) onPick(attachable);
              setOpen(false);
            }}
          />
        );
      }}
    />
  );
}

// Mounts alongside the composer card so the visualViewport fallback binds to
// the ref after it has attached (the card only exists in the ready state).
function ComposerKeyboardLift({
  target,
}: {
  target: RefObject<HTMLDivElement | null>;
}) {
  useKeyboardLift(target);
  return null;
}

export interface NewChatPanelProps {
  // The route the draft lifecycle route-replaces to: /chats/new on the
  // dedicated page, /chats when embedded in the two-pane list.
  basePath: string;
}

export function NewChatPanel({ basePath }: NewChatPanelProps) {
  const route = useRoute();
  const paramDraftId = route.query.get('draft');
  const draft = useStoredDraft({
    paramDraftId,
    basePath,
    onSubmitted: (chatId) => {
      navigate(`/chats/${chatId}`);
    },
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const footRef = useRef<HTMLDivElement | null>(null);

  const grow = useCallback(() => {
    const textarea = textareaRef.current;
    const card = cardRef.current;
    const foot = footRef.current;
    if (textarea === null || card === null || foot === null) return;
    const base = 76;
    const limit = Math.max(
      140,
      window.innerHeight -
        card.getBoundingClientRect().top -
        foot.offsetHeight -
        84,
    );
    textarea.style.height = 'auto';
    const need = textarea.scrollHeight;
    textarea.style.height = `${Math.max(base, Math.min(need, limit))}px`;
    textarea.style.overflowY = need > limit ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    grow();
  }, [grow, draft.message, draft.attachments.length]);

  useEffect(() => {
    const onResize = () => {
      grow();
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [grow]);

  const mention = useMentionPicker({
    textareaRef,
    value: draft.message,
    onChange: draft.setMessage,
    onPick: draft.addAttachment,
    disabled: draft.submitState.status === 'sending',
  });

  const submit = useCallback(() => {
    draft.submit();
  }, [draft]);

  const onComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mention.handleKeyDown(event)) return;
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    },
    [mention, submit],
  );

  const applySuggestion = useCallback(
    (text: string) => {
      draft.setMessage(text);
      textareaRef.current?.focus();
    },
    [draft],
  );

  const canSend =
    draft.status === 'ready' &&
    draft.draftId !== null &&
    hasMessageText(draft.message) &&
    draft.submitState.status !== 'sending';

  if (draft.status === 'loading') {
    return (
      <div className="newchat-panel">
        <SheetPlaceholder
          kicker="New chat"
          heading="Loading draft…"
          body="Looking for a stored draft to resume."
        />
      </div>
    );
  }

  if (draft.status === 'error') {
    return (
      <div className="newchat-panel">
        <PagePlaceholder
          glyph="◌"
          heading="Draft unavailable"
          body="The draft could not be loaded."
          actions={
            <button
              className="btn primary sm"
              type="button"
              onClick={draft.retryLoad}
            >
              Retry
            </button>
          }
        />
      </div>
    );
  }

  if (draft.status === 'not-found') {
    return (
      <div className="newchat-panel">
        <PagePlaceholder
          glyph="◔"
          heading="Draft not found"
          body="This draft is no longer in the workspace. It may have been sent or discarded."
          actions={
            <button
              className="btn primary sm"
              type="button"
              data-testid="draft-start-fresh"
              onClick={draft.startFresh}
            >
              Start fresh
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="newchat-panel">
      <div className="sheet">
        <div className="welcome rise">
          <p className="welcome-t">Start anywhere.</p>
          <p className="welcome-s">
            Write the first message below. The backend answers right away, then
            titles and files the chat itself.
          </p>
          <div className="sgchips">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.label}
                className="sg"
                type="button"
                data-testid="suggestion-chip"
                onClick={() => {
                  applySuggestion(suggestion.text);
                }}
              >
                {suggestion.label}
              </button>
            ))}
          </div>
        </div>

        <ComposerKeyboardLift target={cardRef} />
        <div
          className="nccard rise"
          data-nccard
          data-testid="new-chat-form"
          ref={cardRef}
        >
          <MentionPopup
            open={mention.open}
            items={mention.items}
            activeIndex={mention.activeIndex}
            onPick={mention.pick}
            onClose={mention.close}
            ignoreRef={textareaRef}
            id={mention.popupId}
          />

          <textarea
            ref={textareaRef}
            className="ncmessage"
            aria-controls={mention.popupId}
            data-ncmsg
            data-testid="composer-input"
            rows={2}
            placeholder="Write the first message"
            aria-label="First message"
            value={draft.message}
            onChange={(event) => {
              draft.setMessage(event.currentTarget.value);
            }}
            onKeyDown={onComposerKeyDown}
          />

          {draft.attachments.length > 0 && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                padding: '4px 12px 0',
              }}
            >
              {draft.attachments.map((attachment) => (
                <span
                  className="tag acc"
                  key={attachment.key}
                  data-testid={`attachment-chip-${attachment.id ?? attachment.path ?? attachment.key}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {attachment.label}
                  <button
                    className="link"
                    type="button"
                    aria-label={`Remove ${attachment.label}`}
                    style={{
                      background: 'transparent',
                      border: 0,
                      padding: 0,
                      cursor: 'pointer',
                      font: 'inherit',
                      lineHeight: 1,
                    }}
                    onClick={() => {
                      draft.removeAttachment(attachment.key);
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="ncfoot" ref={footRef}>
            <ProjectMultiSelect
              selected={draft.projects}
              onChange={draft.setProjects}
              disabled={draft.submitState.status === 'sending'}
            />
            <AttachmentPicker
              onPick={draft.addAttachment}
              disabled={draft.submitState.status === 'sending'}
            />
            <BackendPicker
              value={draft.backend}
              onChange={draft.setBackend}
              disabled={draft.submitState.status === 'sending'}
            />
            <span className="grow" />
            {draft.submitState.status === 'sending' ? (
              <button
                className="btn sm"
                type="button"
                data-testid="draft-stop"
                onClick={draft.stopSubmit}
              >
                Stop
              </button>
            ) : (
              <button
                className="btn primary"
                type="button"
                data-testid="send-button"
                disabled={!canSend}
                onClick={submit}
              >
                Start chat
              </button>
            )}
          </div>

          {draft.saveError !== null && draft.submitState.status === 'idle' && (
            <div
              className="note"
              style={{ borderLeftColor: 'var(--warn)', marginTop: 10 }}
            >
              {draft.saveError}
            </div>
          )}

          {draft.submitState.status === 'failed' && (
            <div
              className="note"
              data-testid="submit-error"
              style={{ borderLeftColor: 'var(--danger)', marginTop: 10 }}
            >
              <b>The backend could not answer.</b>{' '}
              {draft.submitState.errorText ?? 'The chat could not be started.'}
              {draft.submitState.diagnostics.length > 0 && (
                <ul style={{ marginTop: 6, paddingLeft: 18 }}>
                  {draft.submitState.diagnostics.map((entry) => (
                    <li key={`${entry.code}:${entry.message}`}>
                      {entry.message}
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ marginTop: 10 }}>
                <button className="btn sm" type="button" onClick={submit}>
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="fnote" style={{ marginTop: 14 }}>
          One dated Markdown file under{' '}
          <span className="mono" style={{ fontSize: 11 }}>
            chats/
          </span>
          . The backend assigns id, title, and topics from your message.
        </p>
      </div>
    </div>
  );
}
