import {
  lexicalSearch,
  type LexicalSearchData,
  type LexicalSearchOptions,
} from '../search/lexical.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface SearchCommandOptions {
  project?: string;
  limit?: number;
  offset?: number;
}

export async function searchCommand(
  query: string,
  options: SearchCommandOptions,
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'search', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const search: LexicalSearchOptions = { query };
  if (options.project !== undefined) {
    search.scope = { kind: 'project', project: options.project };
  }
  if (options.limit !== undefined) search.limit = options.limit;
  if (options.offset !== undefined) search.offset = options.offset;

  const result = await lexicalSearch(resolution.root, search);
  const outcome: CommandOutcome = result.ok
    ? {
        success: true,
        data: result.data,
        diagnostics: result.diagnostics,
        human: renderSearch(result.data),
      }
    : {
        success: false,
        data: null,
        diagnostics: result.diagnostics,
        human: '',
      };
  emitResult(context, 'search', outcome);
  return result.ok ? 0 : 1;
}

function renderSearch(data: LexicalSearchData): string {
  const scope =
    data.scope.kind === 'workspace'
      ? 'workspace'
      : `project ${data.scope.project}`;
  const lines: string[] = [`search: ${data.query} (scope: ${scope})`];
  for (const entry of data.results) {
    if (entry.source === 'repository') {
      lines.push(
        `${entry.repositoryId ?? ''}:${entry.path}:${entry.lineStart ?? ''}: ${compact(entry.snippet)}`,
      );
      continue;
    }
    lines.push(`${entry.path}  ${compact(entry.snippet)}`);
  }
  if (lines.length === 1) lines.push('no matches');
  return `${lines.join('\n')}\n`;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
