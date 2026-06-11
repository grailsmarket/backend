import type { FastifyReply } from 'fastify';
import { normalize } from 'viem/ens';
import {
  getPostgresPool,
  hasEmoji,
  config as appConfig,
  fetchKeywordMetrics,
  hasRealData,
  cacheGoogleMetrics,
  type KeywordMetricsResponse,
} from '../../../../shared/src';
import {
  VALUATION_PROGRESS_STAGE_LABELS,
  type ValuationActivityError,
  type ValuationActivitySale,
  type ValuationCalibrationContextEvidence,
  type ValuationCategoryContextEvidence,
  type ValuationCategoryMarketActivityEvidence,
  type ValuationDomDbPronounceability,
  type ValuationDomDbRegisteredExtension,
  type ValuationDomDbTopExtensionCoverage,
  type ValuationEvidence,
  type ValuationEvidenceResult,
  type ValuationEvidenceStreamErrorEvent,
  type ValuationEvidenceStreamEvent,
  type ValuationEvidenceStreamStageEvent,
  type ValuationMarketActivityEvidence,
  type ValuationMintEvent,
  type ValuationNameResearchEvidence,
  type ValuationProgressStage,
  type ValuationProgressStageStatus,
  type ValuationRelatedTermsEvidence,
  type ValuationSearchDemandEvidence,
  type ValuationWeb2Evidence,
} from './types';
import {
  getCachedEvidence,
  isWeiAtLeast,
  setCachedEvidence,
  valuationLogInfo,
  valuationLogWarn,
  type ValuationConfig,
} from './support';
import { generateAppraisal, generateNameResearch, generateRelatedTerms } from './llm';

/**
 * Valuation orchestration: target resolution (eligibility), the evidence sources
 * (Web2/DomDB, Google search demand, market activity, category activity),
 * calibration, the NDJSON streaming + single-flight registry, and the pipeline
 * that ties them together. The multi-provider LLM engine lives in llm.ts and the
 * DB/config/prompt support lives in support.ts; this module depends on both.
 */

const pool = getPostgresPool();

// ============================================================================
// Streaming + single-flight registry
// ============================================================================

const NDJSON_HEADERS = {
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'X-Accel-Buffering': 'no',
};

export type ValuationProduce = (
  reportProgress: (event: ValuationEvidenceStreamStageEvent) => void
) => Promise<ValuationEvidenceResult>;

export type ValuationErrorMapper = (error: unknown) => { status: number; code: string; message: string };

type ValuationRun = {
  label: string;
  runId: string;
  events: ValuationEvidenceStreamEvent[];
  subscribers: Set<(event: ValuationEvidenceStreamEvent) => void>;
  settled: boolean;
  result?: ValuationEvidenceResult;
  error?: unknown;
  whenSettled: Promise<void>;
};

const registry = new Map<string, ValuationRun>();

/** Visible for diagnostics/tests: how many runs are currently in flight. */
export function inFlightValuationCount(): number {
  return registry.size;
}

/** Returns the live run for a label (for joiners to attach to), or null. */
export function getInFlightValuationRun(label: string): ValuationRun | null {
  const run = registry.get(label);
  return run && !run.settled ? run : null;
}

function startRun(
  label: string,
  runId: string,
  produce: ValuationProduce,
  mapError: ValuationErrorMapper
): ValuationRun {
  const run: ValuationRun = {
    label,
    runId,
    events: [],
    subscribers: new Set(),
    settled: false,
    whenSettled: Promise.resolve(),
  };

  const emit = (event: ValuationEvidenceStreamEvent) => {
    run.events.push(event);
    for (const subscriber of run.subscribers) {
      try {
        subscriber(event);
      } catch {
        // A failed write to one client must not affect the run or other clients.
      }
    }
  };

  run.whenSettled = (async () => {
    try {
      const result = await produce((stageEvent) => emit(stageEvent));
      run.result = result;
      emit({ type: 'result', data: result });
    } catch (error) {
      run.error = error;
      const mapped = mapError(error);
      const errorEvent: ValuationEvidenceStreamErrorEvent = {
        type: 'error',
        status: mapped.status,
        error: { code: mapped.code, message: mapped.message },
      };
      emit(errorEvent);
    } finally {
      run.settled = true;
      registry.delete(label);
    }
  })();

  registry.set(label, run);
  return run;
}

/**
 * Returns the in-flight run for a label, or starts a new one with `produce`.
 * isInitiator is false when attaching to an already-running pipeline.
 */
export function getOrCreateValuationRun(
  label: string,
  runId: string,
  produce: ValuationProduce,
  mapError: ValuationErrorMapper
): { run: ValuationRun; isInitiator: boolean } {
  const existing = registry.get(label);
  if (existing && !existing.settled) {
    return { run: existing, isInitiator: false };
  }
  return { run: startRun(label, runId, produce, mapError), isInitiator: true };
}

function subscribeToRun(
  run: ValuationRun,
  onEvent: (event: ValuationEvidenceStreamEvent) => void
): () => void {
  for (const event of run.events) {
    onEvent(event);
  }
  if (run.settled) {
    return () => {};
  }
  run.subscribers.add(onEvent);
  return () => run.subscribers.delete(onEvent);
}

/** Streams a run's events to the reply as NDJSON until the run settles. */
export async function pipeRunToReply(reply: FastifyReply, run: ValuationRun): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, NDJSON_HEADERS);

  let clientGone = false;
  raw.on('close', () => {
    clientGone = true;
  });

  await new Promise<void>((resolve) => {
    const onEvent = (event: ValuationEvidenceStreamEvent) => {
      if (clientGone) return;
      try {
        raw.write(`${JSON.stringify(event)}\n`);
      } catch {
        clientGone = true;
      }
    };

    const unsubscribe = subscribeToRun(run, onEvent);
    if (run.settled) {
      unsubscribe();
      resolve();
      return;
    }
    run.whenSettled.finally(() => {
      unsubscribe();
      resolve();
    });
  });

  try {
    if (!clientGone) raw.end();
  } catch {
    // socket already closed
  }
}

/** Resolves with the run's result or rejects with its error (non-streaming path). */
export async function awaitRunOutcome(run: ValuationRun): Promise<ValuationEvidenceResult> {
  await run.whenSettled;
  if (run.error !== undefined) {
    throw run.error;
  }
  if (!run.result) {
    throw new Error('Valuation run settled without a result');
  }
  return run.result;
}

// ============================================================================
// Target resolution + eligibility
// ============================================================================

export type ValuationTarget = {
  normalizedName: string;
  keyword: string;
  expiryDate: string;
  nameId: number;
  categoryContext: ValuationCategoryContextEvidence;
};

type ValuationTargetErrorCode =
  | 'INVALID_NAME'
  | 'SUBNAME_NOT_SUPPORTED'
  | 'EMPTY_KEYWORD'
  | 'KEYWORD_TOO_LONG'
  | 'DIGITS_ONLY_NOT_SUPPORTED'
  | 'EMOJI_ONLY_NOT_SUPPORTED'
  | 'NAME_NOT_IN_DATABASE'
  | 'NAME_MISSING_EXPIRY';

type NameDetailsForEligibility = {
  id: number;
  name: string;
  expiry_date: Date | string | null;
  clubs?: string[] | null;
  club_ranks?: Array<{ club: string; rank: number }> | null;
};

// Strips emoji pictographs + modifiers so a purely-emoji label reduces to empty.
// Digits carry the Unicode Emoji property but are NOT Extended_Pictographic, so
// "123" is left intact here and handled by the digit-only check instead.
const EMOJI_STRIP_PATTERN = /[\p{Extended_Pictographic}\u200D\uFE0F\u20E3]/gu;

export class ValuationTargetError extends Error {
  status = 400;
  code: ValuationTargetErrorCode;

  constructor(code: ValuationTargetErrorCode, message: string) {
    super(message);
    this.name = 'ValuationTargetError';
    this.code = code;
  }
}

function normalizeExactEthName(rawName: string): { normalizedName: string; keyword: string } {
  let normalizedName: string;
  try {
    normalizedName = normalize(rawName.trim());
  } catch {
    throw new ValuationTargetError('INVALID_NAME', 'Invalid ENS name');
  }

  if (!normalizedName.endsWith('.eth')) {
    throw new ValuationTargetError('INVALID_NAME', 'Valuation evidence is only supported for .eth names');
  }

  const keyword = normalizedName.slice(0, -'.eth'.length);
  if (!keyword) {
    throw new ValuationTargetError('EMPTY_KEYWORD', 'Valuation evidence requires a non-empty .eth label');
  }

  if (keyword.includes('.')) {
    throw new ValuationTargetError('SUBNAME_NOT_SUPPORTED', 'Valuation evidence does not support subnames');
  }

  if (keyword.length > 20) {
    throw new ValuationTargetError(
      'KEYWORD_TOO_LONG',
      'Valuation evidence is only supported for labels up to 20 characters'
    );
  }

  if (/^[0-9]+$/.test(keyword)) {
    throw new ValuationTargetError(
      'DIGITS_ONLY_NOT_SUPPORTED',
      'Valuation evidence is not supported for digit-only names'
    );
  }

  if (hasEmoji(keyword) && keyword.replace(EMOJI_STRIP_PATTERN, '').length === 0) {
    throw new ValuationTargetError(
      'EMOJI_ONLY_NOT_SUPPORTED',
      'Valuation evidence is not supported for emoji-only names'
    );
  }

  return { normalizedName, keyword };
}

/**
 * Strict label for the cache/in-flight key: the same normalization generation
 * uses, so an ineligible input can't alias onto another label. Returns null for
 * anything generation would reject (so the route skips the cache and lets
 * generation surface the precise eligibility error).
 */
export function deriveStrictValuationLabel(rawName: string): string | null {
  try {
    return normalizeExactEthName(rawName).keyword;
  } catch {
    return null;
  }
}

function buildCategoryContext(
  data: NameDetailsForEligibility,
  categoryComments: Record<string, string[]>
): ValuationCategoryContextEvidence {
  const clubs = Array.isArray(data.clubs) ? data.clubs : [];
  const clubRanks = Array.isArray(data.club_ranks) ? data.club_ranks : [];
  const categories = clubs.map((club) => {
    const rank = clubRanks.find((entry) => entry.club === club)?.rank ?? null;
    const comments = categoryComments[club] ?? [];

    return { slug: club, rank, comments };
  });

  return {
    source: 'grails_name_endpoint',
    summary: {
      categoriesFound: categories.length,
      rankedCategories: categories.filter((category) => category.rank !== null).length,
      commentsFound: categories.reduce((sum, category) => sum + category.comments.length, 0),
    },
    categories,
  };
}

export async function resolveValuationTarget(
  rawName: string,
  options: { logPrefix?: string; categoryComments: Record<string, string[]> }
): Promise<ValuationTarget> {
  const logPrefix = options.logPrefix || '[valuation]';
  const { normalizedName, keyword } = normalizeExactEthName(rawName);
  const startedAt = performance.now();
  valuationLogInfo(logPrefix, 'valuation target eligibility request start', { normalizedName, keyword });

  const result = await pool.query(
    `SELECT
       en.id,
       en.name,
       en.expiry_date,
       en.clubs,
       (SELECT json_agg(json_build_object('club', cm.club_name, 'rank', cm.rank))
        FROM club_memberships cm
        WHERE cm.ens_name = en.name AND cm.rank IS NOT NULL
       ) AS club_ranks
     FROM ens_names en
     WHERE en.name = $1`,
    [normalizedName]
  );

  if (result.rows.length === 0) {
    valuationLogWarn(logPrefix, 'valuation target missing from Grails DB', { normalizedName });
    throw new ValuationTargetError('NAME_NOT_IN_DATABASE', 'Valuation evidence is only supported for names in Grails');
  }

  const data = result.rows[0] as NameDetailsForEligibility;

  if (!data.expiry_date) {
    throw new ValuationTargetError(
      'NAME_MISSING_EXPIRY',
      'Valuation evidence is only supported for names with expiry data'
    );
  }

  const expiryDate = data.expiry_date instanceof Date ? data.expiry_date.toISOString() : String(data.expiry_date);
  const categoryContext = buildCategoryContext(data, options.categoryComments);

  valuationLogInfo(logPrefix, 'valuation target resolved', {
    normalizedName,
    keyword,
    nameId: data.id,
    categoriesFound: categoryContext.summary.categoriesFound,
    categoryCommentsFound: categoryContext.summary.commentsFound,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  return { normalizedName, keyword, expiryDate, nameId: data.id, categoryContext };
}

// ============================================================================
// Web2 footprint (DomDB)
// ============================================================================

type DomDbEnvelope<T> = {
  errors?: Array<{ code?: string | number; message?: string; parameter?: string[] }>;
  duration?: number;
  data?: T | null;
};

type DomDbDomainResponse = {
  domain?: string;
  availability?: string;
  registryPremium?: boolean;
  pronounceability?: unknown;
  extensionsRegistered?: Array<{ extension?: string; availability?: string; popularity?: string | number }>;
};

class DomDbDomainNotFoundError extends Error {
  constructor(message = 'DomDB domain not found') {
    super(message);
    this.name = 'DomDbDomainNotFoundError';
  }
}

class DomDbRequestError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'DomDbRequestError';
    this.status = options.status;
    this.code = options.code;
  }
}

const DOMDB_API_URL = 'https://api.domdb.com/v1';
const DOMDB_REQUEST_TIMEOUT_MS = 15_000;
const DOMDB_MAX_RETRIES = 2;
const TOP_EXTENSIONS = [
  'com', 'net', 'org', 'co', 'io', 'ai', 'xyz', 'app',
  'dev', 'me', 'us', 'info', 'online', 'tech', 'cc', 'tv',
];

function parseNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeExtension(value: unknown): string | null {
  const extension = String(value || '')
    .toLowerCase()
    .replace(/^\./, '');
  return extension || null;
}

function normalizePronounceability(value: unknown): ValuationDomDbPronounceability[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const record = entry as Record<string, unknown>;
        return {
          locale:
            typeof record.locale === 'string'
              ? record.locale
              : typeof record.language === 'string'
                ? record.language
                : null,
          score: parseNumber(record.score),
        };
      })
      .filter((entry): entry is ValuationDomDbPronounceability => Boolean(entry));
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([locale, score]) => ({
      locale,
      score: parseNumber(score),
    }));
  }

  return [];
}

function normalizeRegisteredExtensions(
  value: DomDbDomainResponse['extensionsRegistered']
): ValuationDomDbRegisteredExtension[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  return value
    .map((extension) => {
      const normalized = normalizeExtension(extension.extension);
      if (!normalized || seen.has(normalized)) return null;
      seen.add(normalized);
      return {
        extension: normalized,
        availability: typeof extension.availability === 'string' ? extension.availability : null,
        popularity: parseNumber(extension.popularity),
      };
    })
    .filter((extension): extension is ValuationDomDbRegisteredExtension => Boolean(extension));
}

function buildTopExtensionCoverage(
  registeredExtensions: ValuationDomDbRegisteredExtension[]
): ValuationDomDbTopExtensionCoverage[] {
  const byExtension = new Map(registeredExtensions.map((extension) => [extension.extension, extension]));
  return TOP_EXTENSIONS.map((extension) => ({ extension, registered: Boolean(byExtension.get(extension)) }));
}

function getPrimaryPronounceability(pronounceability: ValuationDomDbPronounceability[]) {
  return pronounceability.find((entry) => entry.score !== null) ?? null;
}

function mapDomDbDomainToEvidence(
  lookupDomain: string,
  domain: DomDbDomainResponse,
  source: 'domdb' | 'domdb_empty'
): ValuationWeb2Evidence {
  const pronounceability = normalizePronounceability(domain.pronounceability);
  const primaryPronounceability = getPrimaryPronounceability(pronounceability);
  const registeredExtensions = normalizeRegisteredExtensions(domain.extensionsRegistered);
  const topExtensionCoverage = buildTopExtensionCoverage(registeredExtensions);
  const topExtensionsRegistered = topExtensionCoverage.filter((extension) => extension.registered).length;

  return {
    source,
    lookupDomain,
    summary: {
      registeredExtensions: registeredExtensions.length,
      topExtensionsRegistered,
      topExtensionsChecked: TOP_EXTENSIONS.length,
      pronounceabilityScore: primaryPronounceability?.score ?? null,
      pronounceabilityLocale: primaryPronounceability?.locale ?? null,
    },
    domdb: {
      domain: domain.domain ?? null,
      availability: domain.availability ?? null,
      registryPremium: typeof domain.registryPremium === 'boolean' ? domain.registryPremium : null,
      pronounceability,
      registeredExtensions,
      topExtensionCoverage,
    },
  };
}

function createEmptyDomDbEvidence(lookupDomain: string): ValuationWeb2Evidence {
  return mapDomDbDomainToEvidence(
    lookupDomain,
    { domain: lookupDomain, extensionsRegistered: [], pronounceability: [] },
    'domdb_empty'
  );
}

async function fetchDomDb<T>(path: string, body: Record<string, unknown>, logPrefix: string): Promise<T> {
  const apiKeyPublic = appConfig.valuation.domdbApiKeyPublic;
  const apiKeyPrivate = appConfig.valuation.domdbApiKeyPrivate;
  if (!apiKeyPublic || !apiKeyPrivate) {
    throw new DomDbRequestError('DOMDB_API_KEY_PUBLIC and DOMDB_API_KEY_PRIVATE are required', {
      code: 'MISSING_DOMDB_KEYS',
    });
  }

  // DomDB is a hard dependency for every uncached generation (the comps gate
  // needs the footprint), so ride out transient blips with a bounded timeout +
  // retries on network/timeout and 5xx. Definitive errors (DOMAIN_NOT_FOUND,
  // 4xx, envelope errors) are not retried.
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= DOMDB_MAX_RETRIES; attempt++) {
    const startedAt = performance.now();
    valuationLogInfo(logPrefix, 'DomDB request start', {
      path,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
      attempt: attempt + 1,
      maxAttempts: DOMDB_MAX_RETRIES + 1,
    });

    let response: Response;
    try {
      response = await fetch(`${DOMDB_API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ apiKeyPublic, apiKeyPrivate, ...body }),
        signal: AbortSignal.timeout(DOMDB_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < DOMDB_MAX_RETRIES) {
        const backoffMs = 500 * Math.pow(2, attempt) + Math.random() * 250;
        valuationLogWarn(logPrefix, 'DomDB network/timeout error, retrying', {
          message: lastError.message,
          backoffMs: Math.round(backoffMs),
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw new DomDbRequestError(lastError.message || 'DomDB request failed', { code: 'NETWORK_ERROR' });
    }

    if (response.status >= 500 && attempt < DOMDB_MAX_RETRIES) {
      const backoffMs = 500 * Math.pow(2, attempt) + Math.random() * 250;
      valuationLogWarn(logPrefix, 'DomDB server error, retrying', {
        status: response.status,
        backoffMs: Math.round(backoffMs),
      });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }

    const json = (await response.json().catch(() => null)) as DomDbEnvelope<T> | null;
    const elapsedMs = Math.round(performance.now() - startedAt);
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    valuationLogInfo(logPrefix, 'DomDB response received', {
      path,
      status: response.status,
      durationSeconds: json?.duration,
      errorsFound: errors.length,
      firstErrorCode: errors[0]?.code,
      elapsedMs,
    });

    const firstError = errors[0];
    const firstErrorCode = firstError?.code ? String(firstError.code) : undefined;
    if (firstErrorCode === 'DOMAIN_NOT_FOUND') {
      throw new DomDbDomainNotFoundError(firstError?.message);
    }

    if (!response.ok || !json || errors.length > 0) {
      throw new DomDbRequestError(firstError?.message || `DomDB HTTP ${response.status}`, {
        status: response.status,
        code: firstErrorCode,
      });
    }

    return json.data as T;
  }

  throw new DomDbRequestError(lastError?.message || 'DomDB request failed after retries', { code: 'NETWORK_ERROR' });
}

export async function buildWeb2Evidence(
  name: string,
  options: { logPrefix?: string } = {}
): Promise<ValuationWeb2Evidence> {
  const startedAt = performance.now();
  const logPrefix = options.logPrefix || '[valuation]';
  const lookupDomain = `${name}.com`;

  try {
    valuationLogInfo(logPrefix, 'Web2 evidence DomDB lookup start', { lookupDomain });
    const domain = await fetchDomDb<DomDbDomainResponse>('/domain/get', { domain: lookupDomain }, logPrefix);
    const evidence = mapDomDbDomainToEvidence(lookupDomain, domain, 'domdb');
    valuationLogInfo(logPrefix, 'Web2 evidence DomDB lookup complete', {
      lookupDomain,
      registeredExtensions: evidence.summary.registeredExtensions,
      pronounceabilityScore: evidence.summary.pronounceabilityScore,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return evidence;
  } catch (error) {
    if (error instanceof DomDbDomainNotFoundError) {
      valuationLogInfo(logPrefix, 'Web2 evidence DomDB domain not found', {
        lookupDomain,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return createEmptyDomDbEvidence(lookupDomain);
    }

    valuationLogWarn(logPrefix, 'Web2 evidence DomDB lookup failed', {
      lookupDomain,
      message: error instanceof Error ? error.message : 'Unknown DomDB error',
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}

// ============================================================================
// Search demand (Google Ads keyword metrics via the google_metrics cache)
// ============================================================================

const GOOGLE_METRICS_TTL_DAYS = 365;
const GOOGLE_METRICS_TTL_MS = GOOGLE_METRICS_TTL_DAYS * 24 * 60 * 60 * 1000;

const NO_DATA_NOTE =
  'Google returned no keyword metrics for this term. This can mean no measurable search demand, but Google may also withhold metrics for sensitive, restricted, political, or otherwise blocked terms.';

function createSearchDemandEvidence(
  keyword: string,
  metrics: KeywordMetricsResponse | null,
  error?: ValuationSearchDemandEvidence['error']
): ValuationSearchDemandEvidence {
  const avgMonthlySearches = metrics?.avgMonthlySearches ?? null;
  const monthlyTrend = Array.isArray(metrics?.monthlyTrend) ? metrics!.monthlyTrend : [];
  const estimatedYearlySearches =
    monthlyTrend.length > 0
      ? Math.round((monthlyTrend.reduce((sum, point) => sum + point.searches, 0) / monthlyTrend.length) * 12)
      : null;
  const hasSearchDemandData =
    avgMonthlySearches !== null || estimatedYearlySearches !== null || (metrics?.avgCpc ?? null) !== null;
  const dataStatus = error ? 'error' : hasSearchDemandData ? 'available' : 'no_data';

  return {
    source: 'grails_google_metrics',
    keyword,
    eligible: true,
    dataStatus,
    ...(dataStatus === 'no_data' ? { note: NO_DATA_NOTE } : {}),
    summary: {
      avgMonthlySearches,
      estimatedYearlySearches,
      avgCpc: metrics?.avgCpc ?? null,
      monthlyTrendPoints: monthlyTrend.length,
    },
    monthlyTrend,
    ...(error ? { error } : {}),
  };
}

async function loadKeywordMetrics(keyword: string): Promise<KeywordMetricsResponse | null> {
  const cached = await pool.query(
    `SELECT metrics FROM google_metrics WHERE name = $1 AND expires_at > NOW()`,
    [keyword]
  );
  if (cached.rows.length > 0) {
    return cached.rows[0].metrics as KeywordMetricsResponse;
  }

  const metrics = await fetchKeywordMetrics(keyword);
  if (!metrics) {
    return null;
  }

  await cacheGoogleMetrics(keyword, metrics, GOOGLE_METRICS_TTL_MS);

  if (!hasRealData(metrics)) {
    const lastKnownGood = await pool.query(
      `SELECT metrics FROM google_metrics WHERE name = $1 AND status = 'success'`,
      [keyword]
    );
    return (lastKnownGood.rows[0]?.metrics as KeywordMetricsResponse) ?? metrics;
  }

  return metrics;
}

export async function buildSearchDemandEvidence(
  keyword: string,
  options: { logPrefix?: string } = {}
): Promise<ValuationSearchDemandEvidence> {
  const startedAt = performance.now();
  const logPrefix = options.logPrefix || '[valuation]';
  valuationLogInfo(logPrefix, 'Google metrics evidence request start', { keyword });

  try {
    const metrics = await loadKeywordMetrics(keyword);
    const evidence = createSearchDemandEvidence(keyword, metrics);
    valuationLogInfo(logPrefix, 'Google metrics evidence complete', {
      keyword,
      dataStatus: evidence.dataStatus,
      avgMonthlySearches: evidence.summary.avgMonthlySearches,
      avgCpc: evidence.summary.avgCpc,
      monthlyTrendPoints: evidence.summary.monthlyTrendPoints,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return evidence;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Google metrics error';
    valuationLogWarn(logPrefix, 'Google metrics evidence failed with exception', {
      keyword,
      message,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return createSearchDemandEvidence(keyword, null, { message });
  }
}

// ============================================================================
// Market activity (batched SQL over activity_history)
// ============================================================================

const PER_NAME_EVENT_LIMIT = 50;
const PER_CATEGORY_EVENT_LIMIT = 10;
// Category activity is "recent" market context. Bounding the window keeps the
// window-function scan/sort cheap for large clubs (e.g. 10k-member categories).
const CATEGORY_ACTIVITY_WINDOW_DAYS = 90;

const ACTIVITY_COLUMNS = `
  ah.id, ah.ens_name_id, ah.event_type, ah.actor_address, ah.counterparty_address,
  ah.platform, ah.chain_id, ah.price_wei, ah.currency_address, ah.transaction_hash,
  ah.block_number, ah.metadata, timezone('UTC', ah.created_at) AS created_at,
  en.name, en.token_id, en.clubs
`;

function mapActivityRow(row: any): ValuationActivitySale {
  const createdAt =
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: row.id,
    ens_name_id: row.ens_name_id,
    event_type: row.event_type,
    actor_address: row.actor_address ?? null,
    counterparty_address: row.counterparty_address ?? null,
    platform: row.platform ?? null,
    chain_id: row.chain_id,
    price_wei: row.price_wei ?? null,
    currency_address: row.currency_address ?? null,
    transaction_hash: row.transaction_hash ?? null,
    block_number: row.block_number ?? null,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    created_at: createdAt,
    name: row.name,
    token_id: row.token_id,
    clubs: row.clubs ?? null,
  };
}

export function createSkippedMarketActivityEvidence(
  premiumRegistrationFloorWei: string,
  comparableSaleFloorWei: string,
  skipReason: NonNullable<ValuationMarketActivityEvidence['summary']['skipReason']>,
  skipMessage: string
): ValuationMarketActivityEvidence {
  return {
    summary: {
      termsChecked: 0,
      termsWithSales: 0,
      salesFound: 0,
      salesFloorWei: comparableSaleFloorWei,
      lowValueSalesExcluded: 0,
      termsWithMintEvents: 0,
      mintEventsFound: 0,
      termsWithPremiumRegistrations: 0,
      premiumRegistrationsFound: 0,
      premiumRegistrationFloorWei,
      activityErrorsFound: 0,
      rateLimited: false,
      termsSkippedAfterRateLimit: 0,
      targetNameEventsExcluded: 0,
      skipped: true,
      skipReason,
      skipMessage,
    },
    sales: [],
    mintEvents: [],
    premiumRegistrations: [],
    errors: [],
  };
}

function isPremiumRegistration(
  activity: ValuationActivitySale,
  premiumRegistrationFloorWei: string
): activity is ValuationMintEvent {
  return activity.event_type === 'mint' && isWeiAtLeast(activity.metadata?.premium_wei, premiumRegistrationFloorWei);
}

function isMintEvent(activity: ValuationActivitySale): activity is ValuationMintEvent {
  return activity.event_type === 'mint';
}

function readWei(value: unknown): bigint {
  try {
    return BigInt(String(value || '0'));
  } catch {
    return BigInt(0);
  }
}

function isComparableSale(activity: ValuationActivitySale, comparableSaleFloorWei: string) {
  return activity.event_type === 'sold' && readWei(activity.price_wei) >= BigInt(comparableSaleFloorWei);
}

function compareWeiDesc(a: unknown, b: unknown) {
  const aWei = readWei(a);
  const bWei = readWei(b);
  return aWei === bWei ? 0 : aWei > bWei ? -1 : 1;
}

function getMintSortWei(mint: ValuationMintEvent) {
  return mint.metadata.premium_wei ?? mint.metadata.total_cost_wei ?? mint.price_wei;
}

function isActivityForEnsName(activity: ValuationActivitySale, ensName: string | undefined) {
  return Boolean(ensName) && activity.name.toLowerCase() === ensName?.toLowerCase();
}

export async function hydrateMarketActivity(
  terms: string[],
  premiumRegistrationFloorWei: string,
  comparableSaleFloorWei: string,
  options: { logPrefix?: string; excludeEnsName?: string } = {}
): Promise<ValuationMarketActivityEvidence> {
  const startedAt = performance.now();
  const logPrefix = options.logPrefix || '[valuation]';
  valuationLogInfo(logPrefix, 'activity hydration start', {
    terms: terms.length,
    premiumRegistrationFloorWei,
    comparableSaleFloorWei,
  });

  const names = terms.map((term) => `${term}.eth`);
  const excludeName = options.excludeEnsName?.toLowerCase() ?? null;

  let rows: ValuationActivitySale[] = [];
  if (names.length > 0) {
    const result = await pool.query(
      `SELECT id, ens_name_id, event_type, actor_address, counterparty_address, platform,
              chain_id, price_wei, currency_address, transaction_hash, block_number, metadata,
              created_at, name, token_id, clubs
       FROM (
         SELECT ${ACTIVITY_COLUMNS},
                row_number() OVER (PARTITION BY ah.ens_name_id ORDER BY ah.created_at DESC) AS rn
         FROM activity_history ah
         JOIN ens_names en ON ah.ens_name_id = en.id
         WHERE en.name = ANY($1) AND ah.event_type IN ('sold', 'mint')
       ) t
       WHERE rn <= $2`,
      [names, PER_NAME_EVENT_LIMIT]
    );
    rows = result.rows.map(mapActivityRow);
  }

  const targetNameEventsExcluded = rows.filter((row) => isActivityForEnsName(row, excludeName ?? undefined)).length;
  const activityRows = rows.filter((row) => !isActivityForEnsName(row, excludeName ?? undefined));

  const allSold = activityRows.filter((activity) => activity.event_type === 'sold');
  const comparableSales = allSold.filter((activity) => isComparableSale(activity, comparableSaleFloorWei));
  const mintEvents = activityRows.filter(isMintEvent);
  const premiumRegistrations = mintEvents.filter((activity) =>
    isPremiumRegistration(activity, premiumRegistrationFloorWei)
  );

  const sales = [...comparableSales].sort((a, b) => compareWeiDesc(a.price_wei, b.price_wei));
  const sortedMintEvents = [...mintEvents].sort((a, b) => compareWeiDesc(getMintSortWei(a), getMintSortWei(b)));
  const sortedPremiumRegistrations = [...premiumRegistrations].sort((a, b) =>
    compareWeiDesc(a.metadata.premium_wei, b.metadata.premium_wei)
  );
  const lowValueSalesExcluded = allSold.length - comparableSales.length;

  const termsWithSales = new Set(sales.map((sale) => sale.name.replace(/\.eth$/i, '')));
  const termsWithMintEvents = new Set(sortedMintEvents.map((mint) => mint.name.replace(/\.eth$/i, '')));
  const termsWithPremiumRegistrations = new Set(
    sortedPremiumRegistrations.map((registration) => registration.name.replace(/\.eth$/i, ''))
  );

  valuationLogInfo(logPrefix, 'activity hydration complete', {
    termsChecked: terms.length,
    termsWithSales: termsWithSales.size,
    salesFound: sales.length,
    lowValueSalesExcluded,
    targetNameEventsExcluded,
    termsWithMintEvents: termsWithMintEvents.size,
    mintEventsFound: sortedMintEvents.length,
    termsWithPremiumRegistrations: termsWithPremiumRegistrations.size,
    premiumRegistrationsFound: sortedPremiumRegistrations.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  return {
    summary: {
      termsChecked: terms.length,
      termsWithSales: termsWithSales.size,
      salesFound: sales.length,
      salesFloorWei: comparableSaleFloorWei,
      lowValueSalesExcluded,
      termsWithMintEvents: termsWithMintEvents.size,
      mintEventsFound: sortedMintEvents.length,
      termsWithPremiumRegistrations: termsWithPremiumRegistrations.size,
      premiumRegistrationsFound: sortedPremiumRegistrations.length,
      premiumRegistrationFloorWei,
      activityErrorsFound: 0,
      rateLimited: false,
      termsSkippedAfterRateLimit: 0,
      targetNameEventsExcluded,
      skipped: false,
    },
    sales,
    mintEvents: sortedMintEvents,
    premiumRegistrations: sortedPremiumRegistrations,
    errors: [],
  };
}

export async function hydrateCategoryMarketActivity(
  clubs: string[],
  ignoredCategories: string[],
  options: { logPrefix?: string; excludeEnsName?: string } = {}
): Promise<ValuationCategoryMarketActivityEvidence> {
  const startedAt = performance.now();
  const logPrefix = options.logPrefix || '[valuation]';
  const ignored = new Set(ignoredCategories);
  const uniqueClubs = Array.from(new Set(clubs)).filter(Boolean);
  const skippedCategories = uniqueClubs
    .filter((club) => ignored.has(club))
    .map((slug) => ({ slug, reason: 'ignored_category' as const }));
  const clubsToFetch = uniqueClubs.filter((club) => !ignored.has(club));
  const excludeName = options.excludeEnsName?.toLowerCase() ?? null;

  valuationLogInfo(logPrefix, 'category activity hydration start', { clubs: clubsToFetch, skippedCategories });

  const rowsByClub = new Map<string, ValuationActivitySale[]>();
  for (const club of clubsToFetch) rowsByClub.set(club, []);

  if (clubsToFetch.length > 0) {
    const result = await pool.query(
      `SELECT id, ens_name_id, event_type, actor_address, counterparty_address, platform,
              chain_id, price_wei, currency_address, transaction_hash, block_number, metadata,
              created_at, name, token_id, clubs, match_club
       FROM (
         SELECT ${ACTIVITY_COLUMNS}, c.club AS match_club,
                row_number() OVER (PARTITION BY c.club, ah.event_type ORDER BY ah.created_at DESC) AS rn
         FROM activity_history ah
         JOIN ens_names en ON ah.ens_name_id = en.id
         JOIN unnest($1::text[]) AS c(club) ON c.club = ANY(en.clubs)
         WHERE ah.event_type IN ('sold', 'mint')
           AND ah.created_at > NOW() - make_interval(days => $3)
       ) t
       WHERE rn <= $2`,
      [clubsToFetch, PER_CATEGORY_EVENT_LIMIT, CATEGORY_ACTIVITY_WINDOW_DAYS]
    );
    for (const raw of result.rows) {
      const list = rowsByClub.get(raw.match_club);
      if (list) list.push(mapActivityRow(raw));
    }
  }

  const categories = clubsToFetch.map((slug) => {
    const allRows = rowsByClub.get(slug) ?? [];
    const targetNameEventsExcluded = allRows.filter((row) => isActivityForEnsName(row, excludeName ?? undefined)).length;
    const activityRows = allRows.filter((row) => !isActivityForEnsName(row, excludeName ?? undefined));
    const sales = activityRows.filter((activity) => activity.event_type === 'sold');
    const mintEvents = activityRows.filter(isMintEvent);

    return {
      slug,
      eventsFound: activityRows.length,
      salesFound: sales.length,
      mintEventsFound: mintEvents.length,
      targetNameEventsExcluded,
      sales,
      mintEvents,
      errors: [] as ValuationActivityError[],
    };
  });

  const eventsFound = categories.reduce((sum, category) => sum + category.eventsFound, 0);
  const salesFound = categories.reduce((sum, category) => sum + category.salesFound, 0);
  const mintEventsFound = categories.reduce((sum, category) => sum + category.mintEventsFound, 0);
  const targetNameEventsExcluded = categories.reduce((sum, category) => sum + category.targetNameEventsExcluded, 0);

  valuationLogInfo(logPrefix, 'category activity hydration complete', {
    categoriesChecked: clubsToFetch.length,
    categoriesSkipped: skippedCategories.length,
    eventsFound,
    salesFound,
    mintEventsFound,
    targetNameEventsExcluded,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  return {
    source: 'grails_category_activity',
    scope: 'category_membership_market_activity',
    note: 'These are recent sold/mint events from categories attached to the target name. They are category-level market context, not direct related-name comparable sales, and may or may not be useful for valuation.',
    summary: {
      categoriesChecked: clubsToFetch.length,
      categoriesSkipped: skippedCategories.length,
      eventsFound,
      salesFound,
      mintEventsFound,
      errorsFound: 0,
      targetNameEventsExcluded,
    },
    skippedCategories,
    categories,
  };
}

// ============================================================================
// Calibration context (thresholds + notes from DB config)
// ============================================================================

export function buildCalibrationContext(
  web2: ValuationWeb2Evidence,
  _searchDemand: ValuationSearchDemandEvidence,
  categoryContext: ValuationCategoryContextEvidence,
  config: ValuationConfig
): ValuationCalibrationContextEvidence {
  const { searchDemand: searchCalibration, web2Footprint: web2Calibration } = config.calibration;

  return {
    source: 'derived_calibration_v1',
    searchDemand: {
      avgMonthlySearches: searchCalibration.avgMonthlySearches,
      avgCpc: searchCalibration.avgCpc,
      notes: searchCalibration.notes,
    },
    web2Footprint: {
      registeredExtensions: web2Calibration.registeredExtensions,
      topExtensionsRegistered: web2Calibration.topExtensionsRegistered,
      pronounceability: web2Calibration.pronounceability,
      compsGate:
        web2.summary.registeredExtensions < web2Calibration.registeredExtensions.tooObscureBelow
          ? 'skipped'
          : 'passed',
      notes: web2Calibration.notes,
    },
    categoryPremiums: categoryContext.categories.map((category) => ({
      category: category.slug,
      rank: category.rank,
      notes: [...category.comments],
    })),
  };
}

// ============================================================================
// Pipeline (with Tier-1 caching of name research + related terms)
// ============================================================================

type ProgressReporter = (event: ValuationEvidenceStreamStageEvent) => void;

function capturePromise<T>(promise: Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: unknown }> {
  return promise.then(
    (data) => ({ ok: true as const, data }),
    (error) => ({ ok: false as const, error })
  );
}

async function getOrGenerateNameResearch(
  label: string,
  config: ValuationConfig,
  logPrefix: string
): Promise<{ nameResearch: ValuationNameResearchEvidence; fromCache: boolean }> {
  let cached: ValuationNameResearchEvidence | null = null;
  try {
    cached = await getCachedEvidence<ValuationNameResearchEvidence>(label, 'name_research');
  } catch (error) {
    valuationLogInfo(logPrefix, 'name research cache read failed; regenerating', {
      error: error instanceof Error ? error.message : error,
    });
  }
  if (cached) {
    valuationLogInfo(logPrefix, 'name research served from Tier-1 cache', { label });
    return { nameResearch: cached, fromCache: true };
  }

  const nameResearch = await generateNameResearch(label, {
    logPrefix,
    maxResearchSenses: config.limits.maxResearchSenses,
  });
  if (nameResearch.dataStatus === 'available') {
    try {
      await setCachedEvidence(label, 'name_research', nameResearch, nameResearch.model, config.ttls.evidenceCacheDays);
    } catch (error) {
      valuationLogInfo(logPrefix, 'name research cache write failed', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
  return { nameResearch, fromCache: false };
}

async function getOrGenerateRelatedTerms(
  label: string,
  nameResearch: ValuationNameResearchEvidence,
  researchFromCache: boolean,
  config: ValuationConfig,
  logPrefix: string
): Promise<ValuationRelatedTermsEvidence> {
  // Only trust cached related terms when the name research was ALSO a cache hit:
  // termSenses indices reference nameResearch.senses, so a regenerated research
  // (possibly different senses) must regenerate related terms too.
  if (researchFromCache) {
    try {
      const cached = await getCachedEvidence<ValuationRelatedTermsEvidence>(label, 'related_terms');
      if (cached) {
        valuationLogInfo(logPrefix, 'related terms served from Tier-1 cache', { label });
        return cached;
      }
    } catch (error) {
      valuationLogInfo(logPrefix, 'related terms cache read failed; regenerating', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  const relatedTerms = await generateRelatedTerms(label, nameResearch.senses, {
    logPrefix,
    termCountsByScore: config.termCounts.byScore,
    maxResearchSenses: config.limits.maxResearchSenses,
  });
  // Don't 1-year-cache a degenerate result where every sense failed (terms would
  // be just the name + number variants); let the next run retry generation.
  const hasUsableSenses = relatedTerms.perSense.some((sense) => !sense.error);
  if (relatedTerms.source === 'ai_scoped_senses' && hasUsableSenses) {
    try {
      await setCachedEvidence(label, 'related_terms', relatedTerms, relatedTerms.model, config.ttls.evidenceCacheDays);
    } catch (error) {
      valuationLogInfo(logPrefix, 'related terms cache write failed', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
  return relatedTerms;
}

export async function runValuationPipeline(args: {
  target: ValuationTarget;
  config: ValuationConfig;
  premiumRegistrationFloorWei: string;
  logPrefix: string;
  reportProgress: ProgressReporter;
}): Promise<ValuationEvidenceResult> {
  const { target, config, premiumRegistrationFloorWei, logPrefix, reportProgress } = args;
  const keyword = target.keyword; // label == keyword (no .eth suffix)
  const comparableSaleFloorWei = config.activity.comparableSaleFloorWei;
  const startedAt = performance.now();

  const emitStage = (
    stage: ValuationProgressStage,
    status: ValuationProgressStageStatus,
    message?: string
  ) => {
    reportProgress({
      type: 'stage',
      stage,
      label: VALUATION_PROGRESS_STAGE_LABELS[stage],
      status,
      message,
      elapsedMs: Math.round(performance.now() - startedAt),
      timestamp: new Date().toISOString(),
    });
  };

  // Eligibility ran in the route; emit the markers for the streaming contract.
  emitStage('checking_eligibility', 'started');
  emitStage('checking_eligibility', 'completed');

  emitStage('measuring_web2_footprint', 'started');
  const web2StartedAt = performance.now();
  const web2Promise = capturePromise(
    buildWeb2Evidence(keyword, { logPrefix }).then((web2) => {
      emitStage(
        'measuring_web2_footprint',
        'completed',
        `${web2.summary.registeredExtensions} registered Web2 extensions found`
      );
      valuationLogInfo(logPrefix, 'Web2 evidence resolved', {
        source: web2.source,
        registeredExtensions: web2.summary.registeredExtensions,
        elapsedMs: Math.round(performance.now() - web2StartedAt),
      });
      return web2;
    })
  );

  emitStage('researching_name_context', 'started');
  const searchDemandPromise = buildSearchDemandEvidence(keyword, { logPrefix });
  const nameResearchPromise = getOrGenerateNameResearch(keyword, config, logPrefix);
  const categoryMarketActivityPromise = hydrateCategoryMarketActivity(
    target.categoryContext.categories.map((category) => category.slug),
    config.activity.ignoredCategories,
    { logPrefix, excludeEnsName: target.normalizedName }
  );

  const evidenceStartedAt = performance.now();
  const web2Result = await web2Promise;
  if (!web2Result.ok) {
    void Promise.allSettled([searchDemandPromise, nameResearchPromise, categoryMarketActivityPromise]);
    throw web2Result.error;
  }

  const web2: ValuationWeb2Evidence = web2Result.data;
  const shouldSkipComps = web2.summary.registeredExtensions < config.compsGate.minWeb2Extensions;
  valuationLogInfo(logPrefix, 'Web2 comparable-sales gate evaluated', {
    registeredExtensions: web2.summary.registeredExtensions,
    minimumRegisteredExtensions: config.compsGate.minWeb2Extensions,
    skipComparableSales: shouldSkipComps,
  });

  let relatedTerms: ValuationRelatedTermsEvidence;
  let marketActivity: ValuationMarketActivityEvidence;
  let searchDemand: ValuationSearchDemandEvidence;
  let nameResearch: ValuationNameResearchEvidence;

  if (shouldSkipComps) {
    relatedTerms = {
      source: 'skipped_web2_footprint_gate',
      model: null,
      senseCount: 0,
      perSense: [],
      termSenses: {},
      baseTermCount: 0,
      numberVariantCount: 0,
      validCount: 0,
      baseTerms: [],
      numberVariants: [],
      terms: [],
      skipped: true,
      skipReason: 'web2_footprint_below_threshold',
      skipMessage: config.compsGate.skipMessage,
    };
    marketActivity = createSkippedMarketActivityEvidence(
      premiumRegistrationFloorWei,
      comparableSaleFloorWei,
      'web2_footprint_below_threshold',
      config.compsGate.skipMessage
    );
    const [resolvedSearchDemand, research] = await Promise.all([searchDemandPromise, nameResearchPromise]);
    searchDemand = resolvedSearchDemand;
    nameResearch = research.nameResearch;
    // Emit the in-progress stage's completion before the next stage's status,
    // so consumers see a clean researching->completed, comps->skipped order.
    emitStage('researching_name_context', 'completed');
    emitStage('looking_for_comparable_sales', 'skipped', config.compsGate.skipMessage);
  } else {
    const research = await nameResearchPromise;
    nameResearch = research.nameResearch;
    emitStage('researching_name_context', 'completed');
    emitStage('looking_for_comparable_sales', 'started');

    relatedTerms = await getOrGenerateRelatedTerms(keyword, nameResearch, research.fromCache, config, logPrefix);

    const activityTerms = relatedTerms.terms.filter((term) => `${term}.eth` !== target.normalizedName);
    const [resolvedMarketActivity, resolvedSearchDemand] = await Promise.all([
      hydrateMarketActivity(activityTerms, premiumRegistrationFloorWei, comparableSaleFloorWei, {
        logPrefix,
        excludeEnsName: target.normalizedName,
      }),
      searchDemandPromise,
    ]);
    marketActivity = resolvedMarketActivity;
    searchDemand = resolvedSearchDemand;
    emitStage(
      'looking_for_comparable_sales',
      'completed',
      `${marketActivity.summary.salesFound} sales and ${marketActivity.summary.mintEventsFound} mint events found`
    );
  }

  const categoryMarketActivity = await categoryMarketActivityPromise;
  const calibrationContext = buildCalibrationContext(web2, searchDemand, target.categoryContext, config);

  valuationLogInfo(logPrefix, 'evidence collection complete', {
    elapsedMs: Math.round(performance.now() - evidenceStartedAt),
    salesFound: marketActivity.summary.salesFound,
    mintEventsFound: marketActivity.summary.mintEventsFound,
    registeredExtensions: web2.summary.registeredExtensions,
    searchDemandStatus: searchDemand.dataStatus,
    nameResearchMeanings: nameResearch.meanings.length,
    categoryActivityEvents: categoryMarketActivity.summary.eventsFound,
  });

  const evidenceWithoutAppraisal: Omit<ValuationEvidence, 'appraisal'> = {
    relatedTerms,
    marketActivity,
    web2,
    searchDemand,
    nameResearch,
    categoryContext: target.categoryContext,
    categoryMarketActivity,
    calibrationContext,
  };

  emitStage('writing_valuation_estimate', 'started');
  const appraisal = await generateAppraisal(keyword, evidenceWithoutAppraisal, { logPrefix });
  emitStage('writing_valuation_estimate', 'completed');

  return {
    name: keyword,
    status: 'completed',
    evidence: {
      ...evidenceWithoutAppraisal,
      appraisal,
    },
    generatedAt: new Date().toISOString(),
  };
}
