import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config, type APIResponse } from '../../../shared/src';
import { optionalAuth } from '../middleware/auth';
import { logger } from '../utils/logger';
import {
  ethToWeiString,
  getCachedValuation,
  getValuationConfig,
  getValuationQuotaSnapshot,
  recordValuationGeneration,
  setCachedValuation,
  ValuationConfigError,
  ValuationPromptError,
} from '../services/valuation/support';
import { consumeOpenAICostRunSummary } from '../services/valuation/llm';
import {
  awaitRunOutcome,
  deriveStrictValuationLabel,
  getInFlightValuationRun,
  getOrCreateValuationRun,
  pipeRunToReply,
  resolveValuationTarget,
  runValuationPipeline,
  ValuationTargetError,
  type ValuationProduce,
} from '../services/valuation/pipeline';
import type { ValuationEvidenceRequest, ValuationEvidenceResult } from '../services/valuation/types';

const DEFAULT_RECOMMENDATION_COUNT = 200;

const ParamsSchema = z.object({
  name: z.string().min(1).max(80),
});

/** Bad client input (request body / params). Mapped to 400. */
class ValuationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValuationValidationError';
  }
}

/** Generation produced no usable appraisal (e.g. upstream LLM failure). Mapped to 502. */
class ValuationGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValuationGenerationError';
  }
}

function nowMeta() {
  return { timestamp: new Date().toISOString() };
}

function createValuationRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readIntegerOption(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValuationValidationError(`${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new ValuationValidationError(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

function parseRequestBody(body: ValuationEvidenceRequest | null, premiumDefaultEth: string) {
  const premiumRegistrationFloorEth = body?.premiumRegistrationFloorEth ?? premiumDefaultEth;
  if (!/^\d+(\.\d+)?$/.test(premiumRegistrationFloorEth)) {
    throw new ValuationValidationError('premiumRegistrationFloorEth must be a positive ETH amount');
  }

  return {
    // Validated for API back-compat with the POC client; the scoped-senses
    // pipeline derives per-sense counts from config, so this is currently unused.
    recommendationCount: readIntegerOption(
      body?.recommendationCount,
      DEFAULT_RECOMMENDATION_COUNT,
      1,
      300,
      'recommendationCount'
    ),
    premiumRegistrationFloorEth,
    premiumRegistrationFloorWei: ethToWeiString(premiumRegistrationFloorEth),
  };
}

/** Maps a thrown error to an HTTP status + client-safe code/message. */
function mapValuationError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ValuationTargetError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ValuationValidationError) {
    return { status: 400, code: 'VALIDATION_ERROR', message: error.message };
  }
  if (error instanceof z.ZodError) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'Invalid request parameters' };
  }
  if (error instanceof URIError) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'Malformed name parameter' };
  }
  if (error instanceof ValuationConfigError || error instanceof ValuationPromptError) {
    // Don't leak config/prompt internals; signal retry-later instead.
    return { status: 503, code: 'VALUATION_UNAVAILABLE', message: 'Valuation is temporarily unavailable' };
  }
  if (error instanceof ValuationGenerationError) {
    return { status: 502, code: 'GENERATION_FAILED', message: 'Could not generate a valuation right now. Please try again.' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Failed to generate valuation evidence' };
}

function sendError(reply: FastifyReply, error: unknown) {
  const mapped = mapValuationError(error);
  const response: APIResponse = {
    success: false,
    error: { code: mapped.code, message: mapped.message },
    meta: nowMeta(),
  };
  return reply.status(mapped.status).send(response);
}

function sendResult(reply: FastifyReply, data: ValuationEvidenceResult, cache: 'HIT' | 'MISS') {
  const response: APIResponse<ValuationEvidenceResult> = {
    success: true,
    data,
    meta: nowMeta(),
  };
  return reply.header('X-Cache', cache).send(response);
}

function wantsStream(acceptHeader: string | undefined): boolean {
  return (acceptHeader ?? '').includes('application/x-ndjson');
}

export async function valuationsRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/v1/valuations/:name/evidence
   *
   * Streams (NDJSON) or returns (JSON) an AI valuation for an ENS name.
   * - Cached results (Tier 2) are public; generation requires auth + quota.
   * - Concurrent requests for the same name attach to one in-flight run.
   * - `?refresh=true` (authed) bypasses the Tier-2 cache to regenerate.
   */
  fastify.post(
    '/:name/evidence',
    { preHandler: optionalAuth, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      if (!config.valuation.enabled) {
        return reply.status(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Valuation is not enabled' },
          meta: nowMeta(),
        });
      }

      let rawName: string;
      try {
        const params = ParamsSchema.parse(request.params);
        rawName = decodeURIComponent(params.name);
      } catch (error) {
        // ZodError (>80 chars) / URIError (bad percent-encoding) -> 400, not 500.
        return sendError(reply, error);
      }

      const refresh = (request.query as { refresh?: string } | undefined)?.refresh === 'true';
      const streaming = wantsStream(request.headers.accept);
      // Use the SAME strict normalization as generation for the cache/join key, so
      // an ineligible input (subname, spaces, etc.) can never alias onto another
      // label's cached result or in-flight run. Ineligible -> null -> skip to
      // generation, which returns the precise eligibility error.
      const label = deriveStrictValuationLabel(rawName);

      // 1. Public Tier-2 cache read (skipped on refresh).
      if (label && !refresh) {
        try {
          const cached = await getCachedValuation(label);
          if (cached) {
            return sendResult(reply, cached, 'HIT');
          }
        } catch (error) {
          logger.error({ err: error, label }, 'valuation cache read failed');
        }
      }

      // 2. Attach to an in-flight run for this label (no auth/quota for joiners).
      if (label) {
        const inFlight = getInFlightValuationRun(label);
        if (inFlight) {
          if (streaming) {
            await pipeRunToReply(reply, inFlight);
            return reply;
          }
          try {
            const result = await awaitRunOutcome(inFlight);
            return sendResult(reply, result, 'MISS');
          } catch (error) {
            return sendError(reply, error);
          }
        }
      }

      // 3. Generation requires authentication.
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Log in to generate a valuation' },
          meta: nowMeta(),
        });
      }
      const userId = parseInt(request.user.sub, 10);

      const runId = createValuationRunId();
      const logPrefix = `[valuation:${runId}]`;

      try {
        // 4. Load private config (fail-closed), resolve + validate the target, parse options.
        const valuationConfig = await getValuationConfig();
        const target = await resolveValuationTarget(rawName, {
          logPrefix,
          categoryComments: valuationConfig.categoryComments,
        });
        const options = parseRequestBody(
          (request.body ?? null) as ValuationEvidenceRequest | null,
          valuationConfig.activity.premiumRegistrationFloorEthDefault
        );

        // 5. Per-user quota (rolling window). Joiners above never reach here.
        const quota = await getValuationQuotaSnapshot(userId);
        if (quota.remaining <= 0) {
          return reply.status(429).send({
            success: false,
            error: {
              code: 'QUOTA_EXCEEDED',
              message: `Valuation limit reached (${quota.max} per ${quota.windowDays} days). Resets ${quota.resetsAt}.`,
            },
            meta: nowMeta(),
          });
        }

        // 6. Single-flight run. Persistence + audit live in produce so a client
        //    disconnect can't abort the generation or skip caching.
        const produce: ValuationProduce = async (reportProgress) => {
          const runStartedAt = performance.now();
          let result: ValuationEvidenceResult;
          try {
            result = await runValuationPipeline({
              target,
              config: valuationConfig,
              premiumRegistrationFloorWei: options.premiumRegistrationFloorWei,
              logPrefix,
              reportProgress,
            });
          } catch (error) {
            consumeOpenAICostRunSummary(logPrefix);
            logger.error({ err: error, label: target.keyword }, `${logPrefix} valuation generation failed`);
            await recordValuationGeneration({
              userId,
              label: target.keyword,
              runId,
              status: 'failed',
              durationMs: Math.round(performance.now() - runStartedAt),
            }).catch(() => {});
            throw error;
          }

          const costSummary = consumeOpenAICostRunSummary(logPrefix);
          const durationMs = Math.round(performance.now() - runStartedAt);

          // C1: the pipeline reports status 'completed' even when the appraisal
          // errored (it returns error evidence with ethValue '0'). Never cache
          // that — it would be served as a public X-Cache: HIT for ~30d — and
          // don't charge a quota slot for it. Surface an error + record 'failed'.
          if (result.evidence.appraisal.dataStatus !== 'available') {
            logger.warn(
              {
                valuation: logPrefix,
                label: target.keyword,
                appraisalError: result.evidence.appraisal.error?.message,
              },
              `${logPrefix} appraisal errored; not caching, recording failed`
            );
            await recordValuationGeneration({
              userId,
              label: target.keyword,
              runId,
              status: 'failed',
              costUsd: costSummary?.costUsd ?? null,
              durationMs,
            }).catch(() => {});
            throw new ValuationGenerationError(
              result.evidence.appraisal.error?.message || 'Valuation appraisal failed'
            );
          }

          await setCachedValuation(target.keyword, result, userId, valuationConfig.ttls.valuationDays);
          // W6: the result is already cached; a failed audit insert must not turn
          // a successful, cached run into a client-facing error. Log + swallow.
          await recordValuationGeneration({
            userId,
            label: target.keyword,
            runId,
            status: 'completed',
            costUsd: costSummary?.costUsd ?? null,
            durationMs,
          }).catch((error) => {
            logger.error({ err: error, label: target.keyword }, `${logPrefix} generation audit insert failed`);
          });
          if (costSummary) {
            logger.info({ valuation: logPrefix, cost: costSummary }, `${logPrefix} OpenAI run cost summary`);
          }
          return result;
        };

        const { run } = getOrCreateValuationRun(target.keyword, runId, produce, mapValuationError);

        if (streaming) {
          await pipeRunToReply(reply, run);
          return reply;
        }

        const result = await awaitRunOutcome(run);
        return sendResult(reply, result, 'MISS');
      } catch (error) {
        // Pre-stream errors (config/eligibility/validation) and non-streaming
        // generation errors land here as clean JSON responses.
        if (!(error instanceof ValuationTargetError) && !(error instanceof Error && /must be|Invalid ETH amount/.test(error.message))) {
          logger.error({ err: error, rawName }, `${logPrefix} valuation request failed`);
        }
        return sendError(reply, error);
      }
    }
  );
}
