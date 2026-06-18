import { z } from 'zod';
import { normalize } from 'viem/ens';
import { getPostgresPool } from '../../../../shared/src';
import { logger } from '../../utils/logger';
import { getUserTier } from '../global-chat';
import type {
  PublicValuationResult,
  StoredValuationActivityRow,
  StoredValuationResult,
  ValuationActivitySale,
  ValuationEvidenceResult,
} from './types';

/**
 * Support layer for the valuation feature: the private DB-stored config + prompt
 * loaders (fail-closed, versioned, in-memory cached), small pure helpers, and
 * the DB cache + quota access. Grouped here so the engine (llm.ts) and the
 * orchestration (pipeline.ts) can both depend on it without an import cycle.
 */

// ============================================================================
// Logging shim (backed by the API service's pino logger)
// ============================================================================

type LogMetadata = Record<string, unknown>;

export function valuationLogInfo(logPrefix: string, message: string, metadata?: LogMetadata) {
  if (metadata === undefined) {
    logger.info(`${logPrefix} ${message}`);
    return;
  }
  logger.info(metadata, `${logPrefix} ${message}`);
}

export function valuationLogWarn(logPrefix: string, message: string, metadata?: LogMetadata) {
  if (metadata === undefined) {
    logger.warn(`${logPrefix} ${message}`);
    return;
  }
  logger.warn(metadata, `${logPrefix} ${message}`);
}

export function valuationLogError(logPrefix: string, message: string, metadata?: LogMetadata) {
  if (metadata === undefined) {
    logger.error(`${logPrefix} ${message}`);
    return;
  }
  logger.error(metadata, `${logPrefix} ${message}`);
}

// ============================================================================
// Pure helpers (ENS label normalization, wei math)
// ============================================================================

export function normalizeValuationLabel(input: string): string | null {
  const stripped = input.replace(/\.eth$/i, '').trim();
  if (!stripped) return null;

  const cleaned = stripped.replaceAll(' ', '').replaceAll('_', '').replaceAll('.', '').toLowerCase();
  if (!cleaned) return null;

  try {
    return normalize(cleaned);
  } catch {
    return null;
  }
}

/**
 * Compact a generated term into a usable ENS label. Drops 3+ token phrases,
 * compacts separators, lowercases + normalizes. Returns null when unusable.
 */
export function compactEnsLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tokenCount = trimmed.split(/\s+/).length;
  if (tokenCount > 2) return null;

  const compacted = trimmed
    .replaceAll(' ', '')
    .replaceAll('-', '')
    .replaceAll('_', '')
    .replaceAll('.', '')
    .toLowerCase();
  if (!compacted) return null;

  try {
    return normalize(compacted);
  } catch {
    return null;
  }
}

export function dedupeNormalizedLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const label of labels) {
    const normalized = normalizeValuationLabel(label);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

export function ethToWeiString(value: string | number): string {
  const raw = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('Invalid ETH amount');
  }

  const [whole, fractional = ''] = raw.split('.');
  const fractionalPadded = (fractional + '0'.repeat(18)).slice(0, 18);
  return (BigInt(whole) * BigInt(10) ** BigInt(18) + BigInt(fractionalPadded)).toString();
}

export function isWeiAtLeast(value: unknown, floorWei: string): boolean {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return false;
  }

  try {
    return BigInt(value) >= BigInt(floorWei);
  } catch {
    return false;
  }
}

// ============================================================================
// Config loader (private, versioned, fail-closed)
// ============================================================================

const thresholdNote = z.array(z.string());

const ValuationConfigSchema = z.object({
  calibration: z.object({
    searchDemand: z.object({
      avgMonthlySearches: z.object({
        counterSignalBelow: z.number(),
        meaningfulAt: z.number(),
        strongAt: z.number(),
        exceptionalAt: z.number(),
      }),
      avgCpc: z.object({
        meaningfulAt: z.number(),
        strongAt: z.number(),
        exceptionalAt: z.number(),
      }),
      notes: thresholdNote,
    }),
    web2Footprint: z.object({
      registeredExtensions: z.object({
        tooObscureBelow: z.number(),
        meaningfulAt: z.number(),
        strongAt: z.number(),
        exceptionalAt: z.number(),
      }),
      topExtensionsRegistered: z.object({
        max: z.number(),
        meaningfulAt: z.number(),
        strongAt: z.number(),
        exceptionalAt: z.number(),
      }),
      notes: thresholdNote,
    }),
  }),
  compsGate: z.object({
    minWeb2Extensions: z.number(),
    skipMessage: z.string(),
  }),
  termCounts: z.object({
    // Must define an entry for every demand score 1-5; otherwise
    // scopedTermCountForScore throws mid-generation. Validate at load (fail-closed).
    byScore: z
      .record(z.string(), z.number())
      .refine((m) => ['1', '2', '3', '4', '5'].every((k) => typeof m[k] === 'number'), {
        message: 'termCounts.byScore must define a count for every score 1-5',
      }),
  }),
  limits: z.object({
    maxResearchSenses: z.number(),
  }),
  categoryComments: z.record(z.string(), z.array(z.string())),
  activity: z.object({
    ignoredCategories: z.array(z.string()),
    comparableSaleFloorWei: z.string(),
    premiumRegistrationFloorEthDefault: z.string(),
  }),
});

export type ValuationConfig = z.infer<typeof ValuationConfigSchema>;

export class ValuationConfigError extends Error {
  code = 'VALUATION_CONFIG_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ValuationConfigError';
  }
}

const CONFIG_CACHE_TTL_MS = 60_000;
let cachedConfig: { config: ValuationConfig; version: number; expiresAt: number } | null = null;

export function clearValuationConfigCache(): void {
  cachedConfig = null;
}

export async function getValuationConfig(): Promise<ValuationConfig> {
  if (cachedConfig && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.config;
  }

  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT version, config FROM valuation_config WHERE is_active = true LIMIT 1`
  );

  if (result.rows.length === 0) {
    throw new ValuationConfigError(
      'No active valuation_config row found. Seed an active config version via the admin dashboard.'
    );
  }

  const { version, config: rawConfig } = result.rows[0];
  const parsed = ValuationConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new ValuationConfigError(
      `Active valuation_config (version ${version}) failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`
    );
  }

  cachedConfig = { config: parsed.data, version, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS };
  return parsed.data;
}

// ============================================================================
// Prompt loader (private, versioned, fail-closed, placeholder-validated)
// ============================================================================

export const VALUATION_PROMPT_KEYS = [
  'name_research',
  'scoped_terms',
  'number_variants',
  'appraisal',
] as const;

export type ValuationPromptKey = (typeof VALUATION_PROMPT_KEYS)[number];

const EXPECTED_PLACEHOLDERS: Record<ValuationPromptKey, string[]> = {
  name_research: ['label'],
  scoped_terms: ['count'],
  number_variants: [],
  appraisal: ['name'],
};

export class ValuationPromptError extends Error {
  code = 'VALUATION_PROMPT_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ValuationPromptError';
  }
}

const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;

function extractPlaceholders(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(PLACEHOLDER_PATTERN)) {
    found.add(match[1]);
  }
  return [...found];
}

function validatePlaceholders(key: ValuationPromptKey, content: string): void {
  const expected = EXPECTED_PLACEHOLDERS[key];
  const found = extractPlaceholders(content);
  const missing = expected.filter((placeholder) => !found.includes(placeholder));
  const unexpected = found.filter((placeholder) => !expected.includes(placeholder));

  if (missing.length > 0 || unexpected.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing ${missing.map((p) => `{{${p}}}`).join(', ')}`);
    if (unexpected.length > 0) parts.push(`unexpected ${unexpected.map((p) => `{{${p}}}`).join(', ')}`);
    throw new ValuationPromptError(`Prompt "${key}" placeholder mismatch: ${parts.join('; ')}`);
  }
}

const PROMPT_CACHE_TTL_MS = 60_000;
const promptCache = new Map<ValuationPromptKey, { content: string; version: number; expiresAt: number }>();

export function clearValuationPromptCache(): void {
  promptCache.clear();
}

export async function getValuationPrompt(key: ValuationPromptKey): Promise<string> {
  const entry = promptCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.content;
  }

  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT version, content FROM valuation_prompts WHERE prompt_key = $1 AND is_active = true LIMIT 1`,
    [key]
  );

  if (result.rows.length === 0) {
    throw new ValuationPromptError(
      `No active prompt for "${key}". Seed an active version via the admin dashboard.`
    );
  }

  const { version, content } = result.rows[0] as { version: number; content: string };
  validatePlaceholders(key, content);

  promptCache.set(key, { content, version, expiresAt: Date.now() + PROMPT_CACHE_TTL_MS });
  return content;
}

export async function renderValuationPrompt(
  key: ValuationPromptKey,
  vars: Record<string, string> = {}
): Promise<string> {
  const content = await getValuationPrompt(key);
  let rendered = content;

  for (const placeholder of EXPECTED_PLACEHOLDERS[key]) {
    if (vars[placeholder] === undefined) {
      throw new ValuationPromptError(`Prompt "${key}" render missing value for {{${placeholder}}}`);
    }
    rendered = rendered.split(`{{${placeholder}}}`).join(vars[placeholder]);
  }

  return rendered;
}

// ============================================================================
// DB cache (Tier 1 evidence, Tier 2 valuation) + generation audit
// ============================================================================

export type ValuationEvidenceCacheKind = 'name_research' | 'related_terms';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function getCachedEvidence<T>(
  label: string,
  kind: ValuationEvidenceCacheKind
): Promise<T | null> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT payload FROM valuation_evidence_cache
      WHERE label = $1 AND kind = $2 AND expires_at > NOW()`,
    [label, kind]
  );
  return result.rows.length > 0 ? (result.rows[0].payload as T) : null;
}

export async function setCachedEvidence(
  label: string,
  kind: ValuationEvidenceCacheKind,
  payload: unknown,
  model: string | null,
  ttlDays: number
): Promise<void> {
  const pool = getPostgresPool();
  const expiresAt = new Date(Date.now() + ttlDays * MS_PER_DAY);
  await pool.query(
    `INSERT INTO valuation_evidence_cache (label, kind, payload, model, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (label, kind)
     DO UPDATE SET
       payload = EXCLUDED.payload,
       model = EXCLUDED.model,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [label, kind, JSON.stringify(payload), model, expiresAt]
  );
}

export async function getCachedValuation(label: string): Promise<StoredValuationResult | null> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT result FROM valuations WHERE label = $1 AND expires_at > NOW()`,
    [label]
  );
  // The stored payload is the trimmed shape written by setCachedValuation, hence
  // StoredValuationResult (not the full ValuationEvidenceResult).
  return result.rows.length > 0 ? (result.rows[0].result as StoredValuationResult) : null;
}

/**
 * Projects a valuation result down to the client-facing payload: the appraisal
 * (minus the model id), the headline web2 + search-demand metrics, the name's
 * senses, and the comparable-sales count. The methodology-sensitive evidence
 * breakdown stays internal and is never sent over the wire. Accepts either a
 * freshly generated full result or a trimmed cached result — only the
 * always-present `appraisal`/`web2`/`searchDemand`/`nameResearch`/
 * `marketActivity.summary` are read. Pure/non-mutating: the input (used for
 * storage and held in the in-flight run) is left untouched.
 */
export function toPublicValuation(result: ValuationEvidenceResult | StoredValuationResult): PublicValuationResult {
  const { appraisal, web2, searchDemand, nameResearch, marketActivity } = result.evidence;
  const { model: _omitModel, ...publicAppraisal } = appraisal;
  const { monthlyTrend: _omitMonthlyTrend, ...publicSearchDemand } = searchDemand;
  return {
    name: result.name,
    status: result.status,
    generatedAt: result.generatedAt,
    evidence: {
      appraisal: publicAppraisal,
      web2: { source: web2.source, lookupLabel: web2.lookupLabel, summary: web2.summary },
      searchDemand: publicSearchDemand,
      nameResearch: { senses: nameResearch.senses },
      marketActivity: { salesFound: marketActivity.summary.salesFound },
    },
  };
}

function toNumericOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Persisted activity rows (market activity AND category market activity) only need
 * name/date/price: the cached result is read back solely to re-serve a prior
 * valuation, and no consumer (UI or refresh) touches the rest of the DB row.
 * Dropping the other ~13 columns (txn hash, addresses, token id, metadata, clubs,
 * …) keeps valuations.result small. The full rows are still used live during
 * generation (LLM input + streaming); only the stored copy is trimmed. The trimmed
 * shape is encoded by StoredValuationActivityRow / StoredValuationResult, so the
 * truncation is type-checked rather than cast away.
 */
function toStoredActivityRow(row: ValuationActivitySale): StoredValuationActivityRow {
  return {
    name: row.name,
    created_at: row.created_at,
    price_wei: row.price_wei,
  };
}

function trimResultForStorage(result: ValuationEvidenceResult): StoredValuationResult {
  const { marketActivity, categoryMarketActivity } = result.evidence;
  return {
    ...result,
    evidence: {
      ...result.evidence,
      marketActivity: {
        ...marketActivity,
        sales: marketActivity.sales.map(toStoredActivityRow),
        mintEvents: marketActivity.mintEvents.map(toStoredActivityRow),
        premiumRegistrations: marketActivity.premiumRegistrations.map(toStoredActivityRow),
      },
      categoryMarketActivity: {
        ...categoryMarketActivity,
        categories: categoryMarketActivity.categories.map((category) => ({
          ...category,
          sales: category.sales.map(toStoredActivityRow),
          mintEvents: category.mintEvents.map(toStoredActivityRow),
        })),
      },
      // Related terms are generation-time plumbing (the search terms used to find
      // comps); no cache consumer reads them. Keep the scalar metadata/counts but
      // drop the heavy arrays so the stored object stays a valid evidence shape.
      relatedTerms: {
        ...result.evidence.relatedTerms,
        perSense: [],
        termSenses: {},
        baseTerms: [],
        numberVariants: [],
        terms: [],
      },
    },
  };
}

export async function setCachedValuation(
  label: string,
  result: ValuationEvidenceResult,
  generatedBy: number | null,
  ttlDays: number
): Promise<void> {
  const pool = getPostgresPool();
  const expiresAt = new Date(Date.now() + ttlDays * MS_PER_DAY);
  const appraisal = result.evidence.appraisal;
  await pool.query(
    `INSERT INTO valuations (label, result, eth_value, low_eth, high_eth, model, generated_by, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (label)
     DO UPDATE SET
       result = EXCLUDED.result,
       eth_value = EXCLUDED.eth_value,
       low_eth = EXCLUDED.low_eth,
       high_eth = EXCLUDED.high_eth,
       model = EXCLUDED.model,
       generated_by = EXCLUDED.generated_by,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [
      label,
      JSON.stringify(trimResultForStorage(result)),
      toNumericOrNull(appraisal.ethValue),
      toNumericOrNull(appraisal.lowEth),
      toNumericOrNull(appraisal.highEth),
      appraisal.model,
      generatedBy,
      expiresAt,
    ]
  );
}

export async function recordValuationGeneration(params: {
  userId: number;
  label: string;
  runId: string;
  status: 'completed' | 'failed';
  costUsd?: number | null;
  durationMs?: number | null;
}): Promise<void> {
  const pool = getPostgresPool();
  await pool.query(
    `INSERT INTO valuation_generations (user_id, label, run_id, status, cost_usd, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.userId,
      params.label,
      params.runId,
      params.status,
      params.costUsd ?? null,
      params.durationMs ?? null,
    ]
  );
}

// ============================================================================
// Valuation settings (operational knobs, admin-editable, single-row table)
// ============================================================================

/**
 * Operational config for the valuation feature, edited live from the cat-admin
 * panel. Kept separate from the versioned, methodology-sensitive
 * `valuation_config` doc. `quotaAdmin` / `quotaAvatar` are nullable: null =
 * unlimited (mirrors global_chat_config.quota_with_avatar).
 */
export interface ValuationSettings {
  enabled: boolean;
  windowDays: number;
  quotaAdmin: number | null;
  quotaAvatar: number | null;
  quotaName: number;
  quotaDefault: number;
  evidenceCacheDays: number;
  valuationDays: number;
}

const SETTINGS_CACHE_TTL_MS = 30_000;
let cachedSettings: { settings: ValuationSettings; expiresAt: number } | null = null;

export function clearValuationSettingsCache(): void {
  cachedSettings = null;
}

/**
 * Loads the single valuation_settings row. A missing row is treated as
 * DISABLED (fail-safe) so the feature can't silently run on column defaults if
 * the seed migration hasn't been applied.
 */
export async function getValuationSettings(): Promise<ValuationSettings> {
  if (cachedSettings && cachedSettings.expiresAt > Date.now()) {
    return cachedSettings.settings;
  }

  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT enabled, window_days, quota_admin, quota_avatar, quota_name,
            quota_default, evidence_cache_days, valuation_days
       FROM valuation_settings WHERE id = 1`
  );

  let settings: ValuationSettings;
  if (result.rows.length === 0) {
    logger.error('valuation_settings row (id=1) missing; treating feature as disabled');
    settings = {
      enabled: false,
      windowDays: 7,
      quotaAdmin: null,
      quotaAvatar: 60,
      quotaName: 25,
      quotaDefault: 10,
      evidenceCacheDays: 365,
      valuationDays: 30,
    };
  } else {
    const row = result.rows[0];
    settings = {
      enabled: Boolean(row.enabled),
      windowDays: Number(row.window_days),
      quotaAdmin: row.quota_admin === null ? null : Number(row.quota_admin),
      quotaAvatar: row.quota_avatar === null ? null : Number(row.quota_avatar),
      quotaName: Number(row.quota_name),
      quotaDefault: Number(row.quota_default),
      evidenceCacheDays: Number(row.evidence_cache_days),
      valuationDays: Number(row.valuation_days),
    };
  }

  cachedSettings = { settings, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
  return settings;
}

// ============================================================================
// Per-user generation quota (rolling window, tier-aware)
// ============================================================================

export type ValuationQuotaTier = 'admin' | 'avatar' | 'name' | 'default';

export interface ValuationQuotaSnapshot {
  used: number;
  /** null = unlimited (admin or an unlimited ENS tier). */
  max: number | null;
  /** null = unlimited. */
  remaining: number | null;
  resetsAt: string;
  windowDays: number;
  tier: ValuationQuotaTier;
}

/**
 * Resolves the quota tier in priority order: admins (users.is_admin) first, then
 * ENS ownership via the global chat tier resolver (shared definition + cache):
 * avatar > name > default (global chat's 'none').
 */
export async function resolveValuationQuotaTier(args: {
  isAdmin: boolean;
  address: string;
}): Promise<ValuationQuotaTier> {
  if (args.isAdmin) return 'admin';
  // A transient ens_names lookup failure must not block generation: degrade to the
  // (most restrictive) 'default' tier rather than 500-ing the whole request.
  let ensTier: Awaited<ReturnType<typeof getUserTier>>;
  try {
    ensTier = await getUserTier(args.address);
  } catch (error) {
    logger.warn(
      { err: error, address: args.address },
      'valuation tier lookup failed; falling back to default tier'
    );
    return 'default';
  }
  if (ensTier === 'avatar') return 'avatar';
  if (ensTier === 'name') return 'name';
  return 'default';
}

function tierLimit(tier: ValuationQuotaTier, settings: ValuationSettings): number | null {
  switch (tier) {
    case 'admin':
      return settings.quotaAdmin;
    case 'avatar':
      return settings.quotaAvatar;
    case 'name':
      return settings.quotaName;
    case 'default':
      return settings.quotaDefault;
  }
}

export async function getValuationQuotaUsed(userId: number, windowDays: number): Promise<number> {
  const pool = getPostgresPool();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM valuation_generations
      WHERE user_id = $1
        AND status = 'completed'
        AND created_at > NOW() - make_interval(days => $2)`,
    [userId, windowDays]
  );
  return result.rows[0]?.c ?? 0;
}

export async function getValuationQuotaSnapshot(args: {
  userId: number;
  address: string;
  isAdmin: boolean;
}): Promise<ValuationQuotaSnapshot> {
  const settings = await getValuationSettings();
  const windowDays = settings.windowDays;
  const tier = await resolveValuationQuotaTier({ isAdmin: args.isAdmin, address: args.address });
  const max = tierLimit(tier, settings);

  // Unlimited tier: skip the count + oldest-row queries entirely.
  if (max === null) {
    return {
      used: 0,
      max: null,
      remaining: null,
      resetsAt: new Date(Date.now() + windowDays * MS_PER_DAY).toISOString(),
      windowDays,
      tier,
    };
  }

  const used = await getValuationQuotaUsed(args.userId, windowDays);

  const pool = getPostgresPool();
  const oldestResult = await pool.query(
    `SELECT MIN(created_at) AS oldest
       FROM valuation_generations
      WHERE user_id = $1
        AND status = 'completed'
        AND created_at > NOW() - make_interval(days => $2)`,
    [args.userId, windowDays]
  );
  const oldest = oldestResult.rows[0]?.oldest as Date | null;
  const windowMs = windowDays * MS_PER_DAY;
  const resetsAt = oldest ? new Date(oldest.getTime() + windowMs) : new Date(Date.now() + windowMs);

  return {
    used,
    max,
    remaining: Math.max(0, max - used),
    resetsAt: resetsAt.toISOString(),
    windowDays,
    tier,
  };
}
