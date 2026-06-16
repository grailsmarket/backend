import { PassThrough } from 'node:stream';
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
  type ValuationWeb2TldDataTopExtensionCoverage,
} from './types';
import {
  getCachedEvidence,
  isWeiAtLeast,
  setCachedEvidence,
  toPublicValuation,
  valuationLogInfo,
  valuationLogWarn,
  type ValuationConfig,
} from './support';
import { generateAppraisal, generateNameResearch, generateRelatedTerms } from './llm';

/**
 * Valuation orchestration: target resolution (eligibility), the evidence sources
 * (Web2/web2-tld-data, Google search demand, market activity, category activity),
 * calibration, the NDJSON streaming + single-flight registry, and the pipeline
 * that ties them together. The multi-provider LLM engine lives in llm.ts and the
 * DB/config/prompt support lives in support.ts; this module depends on both.
 */

const pool = getPostgresPool();

// ============================================================================
// Streaming + single-flight registry
// ============================================================================

export const NDJSON_HEADERS = {
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
      // Project to the public payload once, here at emit: the buffered event + every
      // streamed copy carry only the public shape, while run.result keeps the full
      // result for internal use (non-streaming sendResult + caching).
      emit({ type: 'result', data: toPublicValuation(result) });
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

/**
 * Builds a readable NDJSON stream of a run's events. Returned to the route as
 * the response body so it flows through Fastify's normal lifecycle — that's
 * what lets @fastify/cors (and helmet) apply their headers, which a hijacked
 * raw socket would bypass. The run itself is decoupled from any one client, so
 * a disconnect just unsubscribes this stream; the generation keeps going.
 */
export function createRunNdjsonStream(run: ValuationRun): PassThrough {
  const stream = new PassThrough();

  const onEvent = (event: ValuationEvidenceStreamEvent) => {
    // Skip writes once the stream is destroyed (client gone) or already ended, so a
    // late event can't throw or pile into a buffer that will never drain.
    if (stream.destroyed || stream.writableEnded) return;
    // Events are already public-projected at emit time (the result event carries the
    // public payload), so each can be serialized straight to the wire.
    stream.write(`${JSON.stringify(event)}\n`);
  };

  const unsubscribe = subscribeToRun(run, onEvent);

  // Client disconnect (Fastify destroys the payload stream) -> stop feeding it.
  // Routine teardown errors are expected on a dropped connection and must not crash
  // the process; anything else is logged so real write/protocol failures stay visible.
  stream.on('close', unsubscribe);
  stream.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    const isTeardown =
      code === 'ERR_STREAM_DESTROYED' ||
      code === 'ERR_STREAM_PREMATURE_CLOSE' ||
      code === 'EPIPE' ||
      code === 'ECONNRESET';
    if (!isTeardown) {
      valuationLogWarn(`[valuation:${run.runId}]`, 'NDJSON stream error', {
        label: run.label,
        code,
        message: err.message,
      });
    }
    unsubscribe();
  });

  if (run.settled) {
    unsubscribe();
    stream.end();
    return stream;
  }

  run.whenSettled.finally(() => {
    unsubscribe();
    if (!stream.destroyed) stream.end();
  });

  return stream;
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
// Web2 footprint (web2-tld-data)
// ============================================================================

type Web2TldDataResponse = {
  query?: string;
  label?: string;
  dns_label?: string | null;
  tld_count?: number;
  tlds?: string[];
  error?: string;
  detail?: string;
};

export class Web2TldDataRequestError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'Web2TldDataRequestError';
    this.status = options.status;
    this.code = options.code;
  }
}

const WEB2_TLD_DATA_DEFAULT_BASE_URL = 'https://web2-tld-data-production.up.railway.app';
const WEB2_TLD_DATA_REQUEST_TIMEOUT_MS = 15_000;
const WEB2_TLD_DATA_MAX_RETRIES = 2;
const TOP_EXTENSIONS = [
  'com', 'net', 'org', 'co', 'io', 'ai', 'xyz', 'app',
  'dev', 'me', 'us', 'info', 'online', 'tech', 'cc', 'tv',
];

function normalizeExtension(value: unknown): string | null {
  const extension = String(value || '')
    .toLowerCase()
    .replace(/^\./, '');
  return extension || null;
}

function normalizeTlds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tlds: string[] = [];
  for (const entry of value) {
    const normalized = normalizeExtension(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tlds.push(normalized);
  }
  return tlds;
}

function buildTopExtensionCoverage(tlds: string[]): ValuationWeb2TldDataTopExtensionCoverage[] {
  const registered = new Set(tlds);
  return TOP_EXTENSIONS.map((extension) => ({ extension, registered: registered.has(extension) }));
}

function mapWeb2TldDataToEvidence(
  lookupLabel: string,
  response: Web2TldDataResponse,
  source: 'web2_tld_data' | 'web2_tld_data_empty'
): ValuationWeb2Evidence {
  const tlds = normalizeTlds(response.tlds);
  const topExtensionCoverage = buildTopExtensionCoverage(tlds);
  const topExtensionsRegistered = topExtensionCoverage.filter((extension) => extension.registered).length;
  // Trust the API-reported count (it is the authoritative tld_count across all
  // ~1,533 zones); fall back to the de-duplicated list length only if absent.
  const tldCount =
    typeof response.tld_count === 'number' && Number.isFinite(response.tld_count)
      ? response.tld_count
      : tlds.length;

  return {
    source,
    lookupLabel,
    summary: {
      registeredExtensions: tldCount,
      topExtensionsRegistered,
      topExtensionsChecked: TOP_EXTENSIONS.length,
    },
    web2TldData: {
      label: typeof response.label === 'string' ? response.label : null,
      dnsLabel: typeof response.dns_label === 'string' ? response.dns_label : null,
      tldCount,
      tlds,
      topExtensionCoverage,
    },
  };
}

async function fetchWeb2TldData(label: string, logPrefix: string): Promise<Web2TldDataResponse> {
  const apiKey = appConfig.valuation.web2TldDataApiKey;
  if (!apiKey) {
    throw new Web2TldDataRequestError('WEB2_TLD_DATA_API_KEY is required', {
      code: 'MISSING_WEB2_TLD_DATA_KEY',
    });
  }

  const baseUrl = (appConfig.valuation.web2TldDataBaseUrl || WEB2_TLD_DATA_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/label/${encodeURIComponent(label)}`;

  // web2-tld-data is a hard dependency for every uncached generation (the comps
  // gate needs the footprint), so ride out transient blips with a bounded timeout
  // + retries on network/timeout and 5xx. A label seen in no zone is NOT an error:
  // the API returns tld_count: 0 (HTTP 200), which we treat as an empty footprint.
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= WEB2_TLD_DATA_MAX_RETRIES; attempt++) {
    const startedAt = performance.now();
    valuationLogInfo(logPrefix, 'web2-tld-data request start', {
      label,
      attempt: attempt + 1,
      maxAttempts: WEB2_TLD_DATA_MAX_RETRIES + 1,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-API-Key': apiKey },
        signal: AbortSignal.timeout(WEB2_TLD_DATA_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < WEB2_TLD_DATA_MAX_RETRIES) {
        const backoffMs = 500 * Math.pow(2, attempt) + Math.random() * 250;
        valuationLogWarn(logPrefix, 'web2-tld-data network/timeout error, retrying', {
          message: lastError.message,
          backoffMs: Math.round(backoffMs),
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw new Web2TldDataRequestError(lastError.message || 'web2-tld-data request failed', {
        code: 'NETWORK_ERROR',
      });
    }

    if (response.status >= 500 && attempt < WEB2_TLD_DATA_MAX_RETRIES) {
      const backoffMs = 500 * Math.pow(2, attempt) + Math.random() * 250;
      valuationLogWarn(logPrefix, 'web2-tld-data server error, retrying', {
        status: response.status,
        backoffMs: Math.round(backoffMs),
      });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }

    const json = (await response.json().catch(() => null)) as Web2TldDataResponse | null;
    const elapsedMs = Math.round(performance.now() - startedAt);
    valuationLogInfo(logPrefix, 'web2-tld-data response received', {
      label,
      status: response.status,
      tldCount: json?.tld_count,
      elapsedMs,
    });

    // A label-level rejection (400 malformed/empty, 404 not found) is not fatal:
    // treat it as an empty footprint, mirroring the old DomDB "domain not found ->
    // empty evidence" path so one odd label can't hard-fail the whole valuation.
    // Auth (401) and server (5xx, already retried above) errors still throw.
    if (response.status === 400 || response.status === 404) {
      valuationLogWarn(logPrefix, 'web2-tld-data label not usable, treating as empty footprint', {
        label,
        status: response.status,
        detail: json?.error || json?.detail,
      });
      return { label, dns_label: null, tld_count: 0, tlds: [] };
    }

    if (!response.ok || !json) {
      throw new Web2TldDataRequestError(
        json?.error || json?.detail || `web2-tld-data HTTP ${response.status}`,
        { status: response.status }
      );
    }

    return json;
  }

  throw new Web2TldDataRequestError(lastError?.message || 'web2-tld-data request failed after retries', {
    code: 'NETWORK_ERROR',
  });
}

export async function buildWeb2Evidence(
  name: string,
  options: { logPrefix?: string } = {}
): Promise<ValuationWeb2Evidence> {
  const startedAt = performance.now();
  const logPrefix = options.logPrefix || '[valuation]';
  // web2-tld-data looks up a bare label (it strips a trailing .eth and normalizes
  // unicode to punycode itself); `name` is already the .eth label with no suffix.
  const lookupLabel = name;

  try {
    valuationLogInfo(logPrefix, 'Web2 evidence web2-tld-data lookup start', { lookupLabel });
    const response = await fetchWeb2TldData(lookupLabel, logPrefix);
    const tldCount = typeof response.tld_count === 'number' ? response.tld_count : response.tlds?.length ?? 0;
    const evidence = mapWeb2TldDataToEvidence(
      lookupLabel,
      response,
      tldCount > 0 ? 'web2_tld_data' : 'web2_tld_data_empty'
    );
    valuationLogInfo(logPrefix, 'Web2 evidence web2-tld-data lookup complete', {
      lookupLabel,
      registeredExtensions: evidence.summary.registeredExtensions,
      topExtensionsRegistered: evidence.summary.topExtensionsRegistered,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return evidence;
  } catch (error) {
    valuationLogWarn(logPrefix, 'Web2 evidence web2-tld-data lookup failed', {
      lookupLabel,
      message: error instanceof Error ? error.message : 'Unknown web2-tld-data error',
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
  evidenceCacheDays: number,
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
      await setCachedEvidence(label, 'name_research', nameResearch, nameResearch.model, evidenceCacheDays);
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
  evidenceCacheDays: number,
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
      await setCachedEvidence(label, 'related_terms', relatedTerms, relatedTerms.model, evidenceCacheDays);
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
  evidenceCacheDays: number;
  premiumRegistrationFloorWei: string;
  logPrefix: string;
  reportProgress: ProgressReporter;
}): Promise<ValuationEvidenceResult> {
  const { target, config, evidenceCacheDays, premiumRegistrationFloorWei, logPrefix, reportProgress } = args;
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
  const nameResearchPromise = getOrGenerateNameResearch(keyword, config, evidenceCacheDays, logPrefix);
  // Wrapped in capturePromise so a transient DB rejection can't fire an
  // unhandledRejection during the long (LLM-bound) window before it's awaited
  // below — which, with no global handler, would crash the API process.
  const categoryMarketActivityPromise = capturePromise(
    hydrateCategoryMarketActivity(
      target.categoryContext.categories.map((category) => category.slug),
      config.activity.ignoredCategories,
      { logPrefix, excludeEnsName: target.normalizedName }
    )
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

    relatedTerms = await getOrGenerateRelatedTerms(keyword, nameResearch, research.fromCache, config, evidenceCacheDays, logPrefix);

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

  const categoryMarketActivityResult = await categoryMarketActivityPromise;
  if (!categoryMarketActivityResult.ok) throw categoryMarketActivityResult.error;
  const categoryMarketActivity = categoryMarketActivityResult.data;
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

  // Strip methodology-sensitive content from the CLIENT/cached payload — it was
  // only needed as LLM input above. The full calibration thresholds/notes and the
  // category comment text must not be returned to clients (the result is cached
  // and served publicly as an X-Cache: HIT).
  const { calibrationContext: _omitCalibration, ...publicEvidenceBase } = evidenceWithoutAppraisal;

  return {
    name: keyword,
    status: 'completed',
    evidence: {
      ...publicEvidenceBase,
      categoryContext: {
        ...target.categoryContext,
        categories: target.categoryContext.categories.map((category) => ({
          ...category,
          comments: [],
        })),
      },
      appraisal,
    },
    generatedAt: new Date().toISOString(),
  };
}
