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
  normalizeValuationLabel,
  recordValuationGeneration,
  setCachedValuation,
  ValuationConfigError,
  ValuationPromptError,
} from '../services/valuation/support';
import { consumeOpenAICostRunSummary } from '../services/valuation/llm';
import {
  awaitRunOutcome,
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

function nowMeta() {
  return { timestamp: new Date().toISOString() };
}

function createValuationRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readIntegerOption(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

function parseRequestBody(body: ValuationEvidenceRequest | null, premiumDefaultEth: string) {
  const premiumRegistrationFloorEth = body?.premiumRegistrationFloorEth ?? premiumDefaultEth;
  if (!/^\d+(\.\d+)?$/.test(premiumRegistrationFloorEth)) {
    throw new Error('premiumRegistrationFloorEth must be a positive ETH amount');
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
  if (error instanceof ValuationConfigError || error instanceof ValuationPromptError) {
    // Don't leak config/prompt internals; signal retry-later instead.
    return { status: 503, code: 'VALUATION_UNAVAILABLE', message: 'Valuation is temporarily unavailable' };
  }
  if (error instanceof Error && /must be|Invalid ETH amount/.test(error.message)) {
    return { status: 400, code: 'VALIDATION_ERROR', message: error.message };
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

      const params = ParamsSchema.parse(request.params);
      const rawName = decodeURIComponent(params.name);
      const refresh = (request.query as { refresh?: string } | undefined)?.refresh === 'true';
      const streaming = wantsStream(request.headers.accept);
      const label = normalizeValuationLabel(rawName);

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
          try {
            const result = await runValuationPipeline({
              target,
              config: valuationConfig,
              premiumRegistrationFloorWei: options.premiumRegistrationFloorWei,
              logPrefix,
              reportProgress,
            });
            await setCachedValuation(target.keyword, result, userId, valuationConfig.ttls.valuationDays);
            const costSummary = consumeOpenAICostRunSummary(logPrefix);
            await recordValuationGeneration({
              userId,
              label: target.keyword,
              runId,
              status: 'completed',
              costUsd: costSummary?.costUsd ?? null,
              durationMs: Math.round(performance.now() - runStartedAt),
            });
            if (costSummary) {
              logger.info({ valuation: logPrefix, cost: costSummary }, `${logPrefix} OpenAI run cost summary`);
            }
            return result;
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
