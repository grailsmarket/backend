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

// Domains/protocols that look like links. Kept intentionally broad so we
// don't have to keep adding TLDs — if a comment contains anything that
// vaguely resembles a URL it is rejected.
const URL_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /\bwww\./i,
  /\bipfs:\/\//i,
  /\bens:\/\//i,
  /\bftp:\/\//i,
  /\b[a-z0-9-]+\.(com|net|org|io|xyz|eth|app|co|me|gg|fi|art|finance|tech|dev|sh|cc|tv|so|to|club|info|biz)\b/i,
  /\bt\.me\b/i,
  /@[a-z0-9._-]+\.(com|net|org|io|xyz|eth)/i,
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

  // Strip HTML defensively first; even though our allowlist would reject
  // angle brackets, this gives us a guaranteed-clean baseline.
  const stripped = sanitizeHtml(raw, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });

  const trimmed = stripped.trim();
  if (trimmed.length === 0) {
    return { status: 'rejected', reason: 'Comment cannot be empty' };
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
