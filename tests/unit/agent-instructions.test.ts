import { describe, expect, it } from 'vitest';

import {
  augmentBackendMessage,
  buildAgentInstructions,
} from '../../src/operations/agentInstructions.js';
import type { ResolvedAttachment } from '../../src/operations/attachments.js';

function attachment(
  overrides: Partial<ResolvedAttachment> = {},
): ResolvedAttachment {
  return {
    kind: 'resource',
    path: 'projects/soap-bubbles/context/scaling.md',
    title: 'Scaling notes',
    label: 'Scaling notes',
    mime: 'text/markdown',
    sizeBytes: 12,
    content: 'Scaling body',
    ...overrides,
  };
}

describe('buildAgentInstructions', () => {
  it('describes the workspace, CLI, and API without a server URL', () => {
    const block = buildAgentInstructions();
    expect(block.startsWith('<fieldwork_workspace>')).toBe(true);
    expect(block.endsWith('</fieldwork_workspace>')).toBe(true);
    expect(block).toContain('local-first research workspace');
    expect(block).toContain('fieldwork <command> --json');
    expect(block).toContain('printed by `fieldwork serve`');
    expect(block).not.toContain('http://');
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThan(2048);
  });

  it('prints the live server base URL when one is supplied', () => {
    const block = buildAgentInstructions({
      serverUrl: 'http://127.0.0.1:1774',
    });
    expect(block).toContain('http://127.0.0.1:1774');
    expect(block).not.toContain('printed by `fieldwork serve`');
  });
});

describe('augmentBackendMessage', () => {
  it('puts instructions first, then attachments, then the message', () => {
    const composed = augmentBackendMessage('Summarize the scaling notes.', {
      attachments: [attachment()],
      serverUrl: 'http://127.0.0.1:1774',
    });
    const instructions = composed.indexOf('<fieldwork_workspace>');
    const attachmentBlock = composed.indexOf('<attachment ');
    const message = composed.indexOf('Summarize the scaling notes.');
    expect(instructions).toBe(0);
    expect(attachmentBlock).toBeGreaterThan(instructions);
    expect(message).toBeGreaterThan(attachmentBlock);
    expect(composed).toContain('http://127.0.0.1:1774');
  });

  it('composes instructions and message when there are no attachments', () => {
    const composed = augmentBackendMessage('Hello.');
    expect(composed.startsWith('<fieldwork_workspace>')).toBe(true);
    expect(composed).toContain('\n\nHello.');
    expect(composed).not.toContain('<attachment ');
  });

  it('does not mutate the caller message text', () => {
    const message = 'Keep me unchanged.';
    augmentBackendMessage(message, { attachments: [attachment()] });
    expect(message).toBe('Keep me unchanged.');
  });
});
