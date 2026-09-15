import { describe, expect, it } from 'vitest';

import {
  cancelledDiagnostic,
  isCancelled,
} from '../../src/operations/cancel.js';

describe('cancel decisions', () => {
  it('treats only an aborted signal as cancelled', () => {
    expect(isCancelled(undefined)).toBe(false);
    const controller = new AbortController();
    expect(isCancelled(controller.signal)).toBe(false);
    controller.abort();
    expect(isCancelled(controller.signal)).toBe(true);
  });

  it('builds a warning diagnostic that says nothing was saved', () => {
    const entry = cancelledDiagnostic('chats/x.md', 'chat');
    expect(entry.code).toBe('operation.cancelled');
    expect(entry.severity).toBe('warning');
    expect(entry.message).toContain('nothing was saved');
    expect(cancelledDiagnostic('draft', 'draft').message).toContain('draft');
  });
});
