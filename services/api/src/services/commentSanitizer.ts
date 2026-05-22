import sanitizeHtml from 'sanitize-html';
import { getPostgresPool } from '../../../shared/src';

export type SanitizeOk = {
  status: 'ok';
  body: string;
  bodyCensored: string | null;
};
export type SanitizeRejected = {
  status: 'rejected';
  reason: string;
};
export type SanitizeResult = SanitizeOk | SanitizeRejected;

export interface BlacklistTerm {
  term: string;
  action: 'censor' | 'block';
}

// Block anything that looks like an actual link — a protocol, a `www.`
// prefix, or known shortlink hosts. We deliberately do NOT block bare
// `word.tld` strings: users routinely reference ENS names (brantly.eth,
// foo.box) in comments and the frontend renders comment bodies as plain
// text, so a bare domain mention is just a string. Script-injection is
// independently blocked by the HTML stripper + ALLOWED_CHARS_RE, which
// rejects `/`, `=`, `<`, `>`, `&`, etc.
const URL_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /\bwww\./i,
  /\bipfs:\/\//i,
  /\bens:\/\//i,
  /\bftp:\/\//i,
  /\bt\.me\b/i,
];

// Allowed characters: any Unicode letter (\p{L}), number (\p{N}), whitespace,
// and a curated punctuation set. Anything else (especially angle brackets,
// braces, percent, ampersand, equals, slash, pipe) is rejected — that kills
// every script-injection vector at the door before sanitize-html runs.
const ALLOWED_CHARS_RE = /^[\p{L}\p{N}\s.,!?'"()\-:;@#]+$/u;

// Word-boundary helper for blacklist matching. We escape the term first so
// admin-supplied input can't inject regex metacharacters.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let blacklistCache: { terms: BlacklistTerm[]; expiresAt: number } | null = null;
const BLACKLIST_TTL_MS = 60_000;

export async function getBlacklist(): Promise<BlacklistTerm[]> {
  if (blacklistCache && blacklistCache.expiresAt > Date.now()) {
    return blacklistCache.terms;
  }
  const pool = getPostgresPool();
  const result = await pool.query<BlacklistTerm>(
    `SELECT term, action FROM comment_blacklist_terms`
  );
  blacklistCache = {
    terms: result.rows,
    expiresAt: Date.now() + BLACKLIST_TTL_MS,
  };
  return blacklistCache.terms;
}

export function invalidateBlacklistCache(): void {
  blacklistCache = null;
}

export interface SanitizeOptions {
  maxLength: number;
}

export async function sanitizeCommentBody(
  raw: string,
  opts: SanitizeOptions
): Promise<SanitizeResult> {
  if (typeof raw !== 'string') {
    return { status: 'rejected', reason: 'Comment body must be a string' };
  }

  const rawTrimmed = raw.trim();
  if (rawTrimmed.length === 0) {
    return { status: 'rejected', reason: 'Comment cannot be empty' };
  }

  // Strip HTML defensively first; even though our allowlist would reject
  // angle brackets, this gives us a guaranteed-clean baseline.
  const stripped = sanitizeHtml(raw, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });

  const trimmed = stripped.trim();
  if (trimmed.length === 0) {
    // The user *did* send something — it just consisted entirely of HTML/script
    // that got stripped. Surface a specific message so they aren't told their
    // input was empty when it wasn't.
    return {
      status: 'rejected',
      reason: 'HTML and script tags are not allowed in comments',
    };
  }
  if (trimmed.length > opts.maxLength) {
    return {
      status: 'rejected',
      reason: `Comment cannot exceed ${opts.maxLength} characters`,
    };
  }

  for (const pattern of URL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { status: 'rejected', reason: 'Links are not allowed in comments' };
    }
  }

  if (!ALLOWED_CHARS_RE.test(trimmed)) {
    return {
      status: 'rejected',
      reason: 'Comment contains disallowed characters',
    };
  }

  // Apply blacklist: 'block' rejects, 'censor' replaces with asterisks.
  const terms = await getBlacklist();
  let censored: string | null = null;
  for (const t of terms) {
    const re = new RegExp(`\\b${escapeRegExp(t.term)}\\b`, 'gi');
    if (re.test(trimmed)) {
      if (t.action === 'block') {
        return {
          status: 'rejected',
          reason: 'Comment contains a disallowed term',
        };
      }
      // censor: replace with asterisks of the same length
      const stars = '*'.repeat(t.term.length);
      censored = (censored ?? trimmed).replace(
        new RegExp(`\\b${escapeRegExp(t.term)}\\b`, 'gi'),
        stars
      );
    }
  }

  return {
    status: 'ok',
    body: trimmed,
    bodyCensored: censored,
  };
}
