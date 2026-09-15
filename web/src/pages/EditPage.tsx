import { RenameTitle } from '../shared/controls/index.js';
import { Link, useRoute } from '../shared/router.js';
import { AppShell } from '../shared/shell/AppShell.js';
import { PagePlaceholder } from './stub.js';
import { fileTitle, titleEditable } from './editModel.js';
import { useEditPage } from './useEditPage.js';

export function EditPage() {
  const route = useRoute();
  const path = route.query.get('path');
  const editor = useEditPage(path);
  const file = editor.doc.file;

  if (editor.doc.status === 'loading') {
    return (
      <AppShell breadcrumb={[]} title="Edit file" parentPath="/">
        <PagePlaceholder
          glyph="◔"
          heading="Opening the file…"
          body="Reading the frontmatter and body from the workspace."
        />
      </AppShell>
    );
  }

  if (editor.doc.status === 'error' || file === null) {
    return (
      <AppShell breadcrumb={[]} title="Edit file" parentPath="/">
        <PagePlaceholder
          glyph="◌"
          heading="File unavailable"
          body={
            editor.doc.errorText ??
            'The file could not be opened from this workspace.'
          }
          actions={
            <div className="row-of">
              <button
                className="btn primary sm"
                type="button"
                data-testid="editor-retry"
                onClick={editor.retry}
              >
                Retry
              </button>
              <Link className="btn sm" to="/">
                Back to workspace
              </Link>
            </div>
          }
        />
      </AppShell>
    );
  }

  const title = fileTitle(file);

  return (
    <AppShell breadcrumb={[]} title="Edit file" parentPath="/">
      <div className="sheet wide" data-testid="editor-page">
        <div className="chead rise">
          <h1>
            {titleEditable(file) ? (
              <RenameTitle
                value={title}
                onCommit={editor.commitTitle}
                ariaLabel="File title"
                testId="editor-title"
              />
            ) : (
              <span className="ti" data-testid="editor-title">
                {title}
              </span>
            )}
          </h1>
          <div className="meta">
            <span>{`kind: ${file.kind}`}</span>
          </div>
        </div>

        <form className="rise" onSubmit={(event) => event.preventDefault()}>
          <section className="sect">
            <p className="sl">
              Markdown body{' '}
              <span
                className="cnt mono"
                style={{ textTransform: 'none', letterSpacing: 0 }}
                data-testid="editor-status"
                aria-live="polite"
              >
                {editor.statusText}
              </span>
            </p>
            <textarea
              className="textarea mono"
              data-testid="editor-body"
              value={editor.doc.body}
              onChange={(event) => {
                editor.setBody(event.currentTarget.value);
              }}
              aria-label="Markdown body"
              spellCheck={false}
            />
          </section>
        </form>

        {editor.doc.errorText !== null && editor.doc.conflictHash === null && (
          <div
            className="note"
            data-testid="editor-save-error"
            style={{ borderLeftColor: 'var(--danger)' }}
          >
            {editor.doc.errorText}
          </div>
        )}

        {editor.doc.conflictHash !== null && (
          <div
            className="note"
            data-testid="editor-conflict"
            style={{ borderLeftColor: 'var(--danger)' }}
          >
            This file changed on disk after it was loaded. Nothing was written.
            <div className="row-of" style={{ marginTop: 10 }}>
              <button
                className="btn sm"
                type="button"
                data-testid="editor-reload"
                onClick={editor.reloadFromDisk}
              >
                Reload
              </button>
              <button
                className="btn sm"
                type="button"
                data-testid="editor-keep-editing"
                onClick={editor.keepEditing}
              >
                Keep editing
              </button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
