import { AppShell } from '../shared/shell/AppShell.js';
import { PagePlaceholder } from './stub.js';

export function NotFoundPage() {
  return (
    <AppShell breadcrumb={[]} title="Not found" parentPath="/">
      <PagePlaceholder
        glyph="◌"
        heading="Not found"
        body="This address is not part of the workspace interface."
      />
    </AppShell>
  );
}
