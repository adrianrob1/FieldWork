import { AppShell } from '../shared/shell/AppShell.js';
import { NewChatPanel } from './chats/NewChatPanel.js';

// The dedicated new-chat route. The start view itself lives in NewChatPanel so
// it can also be embedded in the desktop /chats content pane; this page only
// supplies the shell and the explanatory side list.
function DraftListPane() {
  return (
    <>
      <div className="lh">
        <div className="top">
          <span className="t">Draft</span>
        </div>
      </div>
      <div className="rows">
        <div className="card rise" style={{ margin: 14, borderRadius: 12 }}>
          <p className="ct" style={{ fontSize: 13 }}>
            What happens on start
          </p>
          <p className="cs" style={{ fontSize: 12.5 }}>
            A dated Markdown file appears under{' '}
            <span className="mono" style={{ fontSize: 11 }}>
              chats/
            </span>
            . The backend fills in id, title, and topics from your message.
          </p>
        </div>
        <div className="card rise" style={{ margin: 14, borderRadius: 12 }}>
          <p className="ct" style={{ fontSize: 13 }}>
            Recent chats
          </p>
          <p className="cs" style={{ fontSize: 12.5, marginTop: 8 }}>
            Your most recent threads stay in the Chats list while you draft.
          </p>
        </div>
      </div>
    </>
  );
}

export function NewChatPage() {
  return (
    <AppShell
      breadcrumb={[{ label: 'Chats', href: '/chats' }]}
      title="New chat"
      parentPath="/chats"
      list={<DraftListPane />}
    >
      <NewChatPanel basePath="/chats/new" />
    </AppShell>
  );
}
