export const MAX_BRANCHES = 2;
export const MAX_CONTEXT_FILES = 10;
export const MIN_BRANCH_SCORE = 1;

const EXACT_ID_SCORE = 100;
const EXACT_TITLE_SCORE = 60;
const KEYWORD_SCORE = 20;
const KEYWORD_SCORE_CAP = 40;
const FTS_SCORE = 10;
const TOPIC_TERM_SCORE = 3;
const TOPIC_SCORE_CAP = 6;

export interface BranchCandidate {
  id: string;
  title: string;
  path: string;
  kind: string | null;
  project: string | null;
  keywords: string[];
  topics: string[];
  ftsRank: number | null;
}

export interface ScoreComponents {
  exactId: number;
  exactTitle: number;
  keywords: number;
  keywordMatches: string[];
  fts: number;
  topic: number;
  total: number;
}

export interface ScoredBranch extends BranchCandidate {
  score: ScoreComponents;
}

export function scoreBranches(
  query: string,
  candidates: BranchCandidate[],
): ScoredBranch[] {
  const trimmed = query.trim();
  const lowered = trimmed.toLowerCase();
  const terms = lowered.split(/\s+/).filter((term) => term.length > 0);
  const scored = candidates.map((entry) => ({
    ...entry,
    score: scoreCandidate(trimmed, lowered, terms, entry),
  }));
  scored.sort(compareBranches);
  return scored;
}

export function selectBranches(
  branches: ScoredBranch[],
  maxBranches = MAX_BRANCHES,
  floor = MIN_BRANCH_SCORE,
): ScoredBranch[] {
  return branches
    .filter((branch) => branch.score.total >= floor)
    .slice(0, maxBranches);
}

function scoreCandidate(
  trimmed: string,
  lowered: string,
  terms: string[],
  candidate: BranchCandidate,
): ScoreComponents {
  const exactId =
    trimmed !== '' && trimmed === candidate.id ? EXACT_ID_SCORE : 0;
  const exactTitle =
    trimmed !== '' && lowered === candidate.title.toLowerCase()
      ? EXACT_TITLE_SCORE
      : 0;
  const keywordMatches = candidate.keywords.filter((keyword) =>
    matchesKeyword(lowered, terms, keyword),
  );
  const keywords = Math.min(
    KEYWORD_SCORE_CAP,
    KEYWORD_SCORE * keywordMatches.length,
  );
  const fts =
    candidate.ftsRank === null
      ? 0
      : round(FTS_SCORE / (1 + Math.abs(candidate.ftsRank)));
  const overlapping = new Set(
    terms.filter((term) =>
      candidate.topics.some((topic) => topic.toLowerCase().includes(term)),
    ),
  );
  const topic = Math.min(TOPIC_SCORE_CAP, TOPIC_TERM_SCORE * overlapping.size);
  return {
    exactId,
    exactTitle,
    keywords,
    keywordMatches,
    fts,
    topic,
    total: round(exactId + exactTitle + keywords + fts + topic),
  };
}

function matchesKeyword(
  lowered: string,
  terms: string[],
  keyword: string,
): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (normalized === '') return false;
  if (normalized.includes(' ')) return lowered.includes(normalized);
  return terms.includes(normalized);
}

function compareBranches(left: ScoredBranch, right: ScoredBranch): number {
  if (left.score.total !== right.score.total) {
    return right.score.total - left.score.total;
  }
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
