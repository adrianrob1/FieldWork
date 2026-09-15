import { useEffect, useRef, useState, type FormEvent } from 'react';

import { getJson, type ApiFailure } from '../shared/api.js';
import {
  MiddleEllipsis,
  SearchableSelect,
  type OptionItem,
} from '../shared/controls/index.js';
import { toProjectListEntries } from '../shared/projects/catalog.js';
import { Link, navigate, useRoute } from '../shared/router.js';
import { AppShell } from '../shared/shell/AppShell.js';
import { PagePlaceholder } from './stub.js';
import { useApiResource } from './useApiResource.js';
import {
  appendResults,
  hitTarget,
  lineRangeLabel,
  matchLabel,
  parseSnippet,
  searchPagePath,
  searchRoute,
  searchStatus,
  showingLabel,
  toSearchData,
  type SearchData,
  type SearchResultEntry,
} from './searchModel.js';

const workspaceScopeId = '__workspace__';

function displayPath(hit: SearchResultEntry): string {
  return hit.path;
}

function HitCard({ hit }: { hit: SearchResultEntry }) {
  const target = hitTarget(hit);
  const segments = parseSnippet(hit.snippet);
  const body = (
    <>
      <p className="rk">
        <span className="kind">{hit.kind}</span>
        <span className="path">
          <MiddleEllipsis text={displayPath(hit)} />
        </span>
      </p>
      <p className="rs">
        {segments.map((segment, index) =>
          segment.match ? (
            <mark key={index}>{segment.text}</mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </p>
      <p className="rm">
        {!target.navigable && (
          <>
            <span>{`${target.repositoryId} · ripgrep`}</span>
            <span>{lineRangeLabel(hit)}</span>
          </>
        )}
        {target.navigable && (
          <>
            <span>{lineRangeLabel(hit)}</span>
            {hit.objectId !== null && <span>{hit.objectId}</span>}
          </>
        )}
        <span>{matchLabel(hit.matchCount)}</span>
      </p>
    </>
  );
  if (!target.navigable) {
    return (
      <div
        className="rhit"
        data-testid="search-hit"
        style={{ cursor: 'default' }}
      >
        {body}
      </div>
    );
  }
  return (
    <Link className="rhit" to={target.to} data-testid="search-hit">
      {body}
    </Link>
  );
}

function SearchResults({ q, project }: { q: string; project: string | null }) {
  const [data, setData] = useState<SearchData | null>(null);
  const [results, setResults] = useState<SearchResultEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const requestRef = useRef(0);
  const now = new Date();

  useEffect(() => {
    let active = true;
    requestRef.current += 1;
    setStatus('loading');
    setData(null);
    setResults([]);
    setHasMore(false);
    setLoadingMore(false);
    setMoreError(null);
    void getJson<unknown>(searchRoute(q, project, 0, 0)).then((outcome) => {
      if (!active) return;
      if (outcome.ok) {
        const next = toSearchData(outcome.data);
        setData(next);
        setResults(next.results);
        setHasMore(next.hasMore);
        setStatus('ready');
        return;
      }
      setFailure(outcome.failure);
      setStatus('error');
    });
    return () => {
      active = false;
    };
  }, [q, project, nonce]);

  const loadMore = async () => {
    if (data === null || loadingMore) return;
    const token = requestRef.current;
    setLoadingMore(true);
    setMoreError(null);
    const outcome = await getJson<unknown>(
      searchRoute(q, project, results.length, data.limit),
    );
    if (token !== requestRef.current) return;
    setLoadingMore(false);
    if (!outcome.ok) {
      setMoreError(
        outcome.failure.errorText ??
          'The remaining results could not be loaded.',
      );
      return;
    }
    const page = toSearchData(outcome.data);
    setResults((previous) => appendResults(previous, page.results));
    setHasMore(page.hasMore);
  };

  if (status === 'loading') {
    return (
      <PagePlaceholder
        glyph="⌕"
        heading="Searching…"
        body="Running SQLite FTS5 over workspace documents and ripgrep over registered repositories."
      />
    );
  }
  if (status === 'error') {
    return (
      <PagePlaceholder
        glyph="◌"
        heading="Search unavailable"
        body={failure?.errorText ?? 'The search request failed.'}
        actions={
          <button
            className="btn primary sm"
            type="button"
            onClick={() => {
              setNonce((value) => value + 1);
            }}
          >
            Retry
          </button>
        }
      />
    );
  }
  if (data === null) return null;
  const statusView = searchStatus(data, now);
  return (
    <>
      <div
        className="meta"
        style={{ marginTop: 14 }}
        data-testid="search-status"
      >
        <span>{statusView.hitsLabel}</span>
        <span>·</span>
        <span className="mono">{statusView.durationLabel}</span>
        <span>·</span>
        <span>{statusView.indexLabel}</span>
      </div>

      {results.length === 0 ? (
        <div className="empty" style={{ padding: '32px 0' }}>
          <p className="glyph">⌕</p>
          <h2>No matches</h2>
          <p>
            Nothing in this workspace matched {`"${data.query}"`}. Try fewer or
            different terms.
          </p>
        </div>
      ) : (
        <div className="rise" data-testid="search-results">
          {results.map((hit, index) => (
            <HitCard
              key={`${hit.source}:${hit.repositoryId ?? ''}:${hit.path}:${index}`}
              hit={hit}
            />
          ))}
        </div>
      )}

      {moreError !== null && (
        <p
          className="note"
          style={{ marginTop: 12, borderLeftColor: 'var(--danger)' }}
        >
          {moreError}
        </p>
      )}

      {data.totalResults > 0 && (
        <p className="fnote" style={{ marginTop: 20 }}>
          {showingLabel(data.totalResults, results.length)}
          {hasMore && (
            <>
              {' · '}
              <button
                className="link"
                type="button"
                disabled={loadingMore}
                data-testid="search-more"
                style={{
                  background: 'transparent',
                  border: 0,
                  padding: 0,
                  cursor: 'pointer',
                  font: 'inherit',
                }}
                onClick={() => {
                  void loadMore();
                }}
              >
                {loadingMore ? 'loading…' : 'Load remaining'}
              </button>
            </>
          )}
        </p>
      )}
    </>
  );
}

export function SearchPage() {
  const route = useRoute();
  const activeQuery = route.query.get('q') ?? '';
  const activeProject = route.query.get('project');
  const [query, setQuery] = useState(activeQuery);
  const projectsResource = useApiResource<unknown>('/api/projects');
  const projects =
    projectsResource.state.status === 'ready'
      ? toProjectListEntries(projectsResource.state.data)
      : [];

  useEffect(() => {
    setQuery(route.query.get('q') ?? '');
  }, [route.search]);

  const scopeItems: OptionItem[] = [
    { id: workspaceScopeId, label: 'whole workspace' },
    ...projects.map((project) => ({
      id: project.id,
      label: project.title,
      keywords: [project.id],
    })),
  ];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    navigate(searchPagePath(trimmed, activeProject), { replace: true });
  };

  const setScope = (id: string) => {
    const project = id === workspaceScopeId ? null : id;
    navigate(searchPagePath(activeQuery, project), { replace: true });
  };

  const list = (
    <>
      <div className="lh">
        <div className="top">
          <span className="t">This search</span>
        </div>
      </div>
      <div className="rows">
        <div className="card rise" style={{ margin: 14, borderRadius: 12 }}>
          <p className="ct" style={{ fontSize: 13 }}>
            Scope
          </p>
          <div style={{ marginTop: 12 }}>
            <SearchableSelect
              items={scopeItems}
              value={activeProject ?? workspaceScopeId}
              onChange={setScope}
              ariaLabel="Search scope"
              placeholder="whole workspace"
              testId="search-scope"
            />
          </div>
        </div>
        <div className="card rise" style={{ margin: 14, borderRadius: 12 }}>
          <p className="ct" style={{ fontSize: 13 }}>
            How it searches
          </p>
          <p className="cs" style={{ fontSize: 12.5 }}>
            Workspace documents go through SQLite FTS5; registered repositories
            go through ripgrep. The index is disposable. Delete and rebuild it
            any time.
          </p>
        </div>
      </div>
    </>
  );

  return (
    <AppShell breadcrumb={[]} title="Search" parentPath="/" list={list}>
      <div className="sheet wide">
        <div className="chead rise">
          <form
            className="composer sform"
            style={{ padding: '12px 14px' }}
            onSubmit={submit}
            data-testid="search-form"
          >
            <input
              className="input"
              style={{
                border: 0,
                background: 'transparent',
                padding: '2px 4px',
                fontSize: 16,
              }}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              aria-label="Search query"
              placeholder="Search the workspace"
              autoFocus
              data-testid="search-input"
            />
            <SearchableSelect
              items={scopeItems}
              value={activeProject ?? workspaceScopeId}
              onChange={setScope}
              ariaLabel="Search scope"
              placeholder="whole workspace"
              testId="search-scope-inline"
            />
            <button className="btn primary sm" type="submit">
              Search
            </button>
          </form>
        </div>

        {activeQuery === '' ? (
          <div className="empty" style={{ padding: '40px 0' }}>
            <p className="glyph">⌕</p>
            <h2>Search the workspace</h2>
            <p>
              Type a query to search workspace documents through SQLite FTS5 and
              registered repositories through ripgrep. Results are evidence, not
              answers.
            </p>
          </div>
        ) : (
          <SearchResults q={activeQuery} project={activeProject} />
        )}
      </div>
    </AppShell>
  );
}
