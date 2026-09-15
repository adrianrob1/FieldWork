import { SlideOver } from '../../shared/controls/index.js';
import {
  shortHash,
  unknownKeysText,
  type EditableFile,
} from './attachmentEditor.js';
import type { AttachmentEditor } from './useAttachmentEditor.js';

export interface AttachmentSlideOverProps {
  editor: AttachmentEditor;
}

function basename(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

function fileTitle(file: EditableFile): string {
  const title = file.metadata.title;
  if (typeof title === 'string' && title !== '') return title;
  return basename(file.path);
}

function fileId(file: EditableFile): string | null {
  const id = file.metadata.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

export function AttachmentSlideOver({ editor }: AttachmentSlideOverProps) {
  const file = editor.file;
  const title = file === null ? 'Attachment' : fileTitle(file);
  const id = file === null ? null : fileId(file);
  const hashLabel =
    editor.expectedHash === null
      ? ''
      : `hash ${shortHash(editor.expectedHash)}${
          editor.conflictHash === null ? '' : ' · stale → 409'
        }`;
  const saveDisabled =
    !editor.dirty || editor.saving || editor.conflictHash !== null;
  const footer = (
    <>
      <span className="ede-hash mono" data-testid="attachment-hash">
        {hashLabel}
      </span>
      <span style={{ flex: 1 }} />
      <button className="btn sm" type="button" onClick={editor.close}>
        Discard
      </button>
      <button
        className="btn primary sm"
        type="button"
        data-testid="attachment-save"
        disabled={saveDisabled}
        onClick={editor.save}
      >
        {editor.saving ? 'Saving…' : editor.saved ? 'Saved' : 'Save file'}
      </button>
    </>
  );

  return (
    <SlideOver
      open={editor.open}
      onClose={editor.close}
      title={title}
      ariaLabel="Markdown editor"
      testId="attachment-editor"
      footer={footer}
    >
      {editor.status === 'loading' && (
        <p className="stub-note">Loading file…</p>
      )}
      {editor.status === 'error' && (
        <div
          className="note"
          data-testid="attachment-error"
          style={{ borderLeftColor: 'var(--danger)' }}
        >
          {editor.errorText ?? 'The attachment could not be opened.'}
        </div>
      )}
      {editor.status === 'ready' && file !== null && (
        <>
          <div className="ede-sub">
            <span className="chip">{file.kind}</span>
            {id !== null && <span className="chip mono">{id}</span>}
            <span className="chip mono">{file.path}</span>
          </div>
          <p className="ede-sec">Unknown frontmatter</p>
          <div className="ede-ro mono" data-testid="attachment-unknown">
            {unknownKeysText(file.metadata, file.unknownKeys)}
          </div>
          <p className="ede-sec" style={{ marginTop: 22 }}>
            Markdown body
          </p>
          <textarea
            className="textarea mono ede-ta"
            data-testid="attachment-body"
            value={editor.body}
            disabled={editor.saving}
            onChange={(event) => {
              editor.setBody(event.currentTarget.value);
            }}
          />
          {editor.conflictHash !== null && (
            <div
              className="note"
              data-testid="attachment-conflict"
              style={{ borderLeftColor: 'var(--danger)' }}
            >
              This file changed on disk after it was loaded. Nothing was
              written.
              <div className="row-of" style={{ marginTop: 10 }}>
                <button
                  className="btn sm"
                  type="button"
                  data-testid="attachment-reload"
                  onClick={editor.reloadFromDisk}
                >
                  Reload
                </button>
                <button
                  className="btn sm"
                  type="button"
                  data-testid="attachment-keep-editing"
                  onClick={editor.keepEditing}
                >
                  Keep editing
                </button>
              </div>
            </div>
          )}
          {editor.errorText !== null && editor.conflictHash === null && (
            <div
              className="note"
              data-testid="attachment-save-error"
              style={{ borderLeftColor: 'var(--danger)' }}
            >
              {editor.errorText}
            </div>
          )}
        </>
      )}
    </SlideOver>
  );
}
