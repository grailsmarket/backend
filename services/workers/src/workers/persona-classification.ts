import PgBoss from 'pg-boss';
import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const QUEUE_NAME = 'classify-personas';
const CRON_SCHEDULE = '0 4 * * *'; // Daily at 4 AM UTC
const BATCH_SIZE = 500;
const MIN_SCORE_THRESHOLD = 0.5;

interface ClassifyPersonasJob {
  addresses?: string[];
}

interface PersonaRow {
  id: number;
  slug: string;
  priority: number;
  criteria: Record<string, unknown>;
  is_default: boolean;
}

interface NameStats {
  name_count: number;
  digit_count: number;
  club_count: number;
  avg_years_remaining: number | null;
  avg_registration_year: number | null;
}

interface TradeStats {
  total_trades: number;
  trades_per_month: number;
}

/**
 * Worker that classifies users into behavioral personas based on their
 * portfolio and marketplace activity. Runs daily and can also be triggered
 * for specific addresses via job data.
 */
export async function registerPersonaClassificationWorker(boss: PgBoss) {
  await boss.work<ClassifyPersonasJob>(
    QUEUE_NAME,
    { teamSize: 1, teamConcurrency: 1 },
    async (job) => {
      const targetAddresses = job.data?.addresses;
      logger.info(
        { jobId: job.id, targetCount: targetAddresses?.length ?? 'all' },
        'Starting persona classification'
      );

      try {
        const pool = getPostgresPool();

        // Load all persona definitions
        const personasResult = await pool.query<PersonaRow>(
          'SELECT id, slug, priority, criteria, is_default FROM personas ORDER BY priority DESC'
        );
        const personas = personasResult.rows;
        const defaultPersona = personas.find(p => p.is_default);

        if (!defaultPersona) {
          throw new Error('No default persona found — run seed migration first');
        }

        // Get all user addresses to classify
        let userAddresses: string[];
        if (targetAddresses && targetAddresses.length > 0) {
          userAddresses = targetAddresses.map(a => a.toLowerCase());
        } else {
          const usersResult = await pool.query<{ address: string }>(
            'SELECT address FROM users'
          );
          userAddresses = usersResult.rows.map(r => r.address);
        }

        logger.info({ userCount: userAddresses.length }, 'Users to classify');

        let classified = 0;

        // Process in batches
        for (let i = 0; i < userAddresses.length; i += BATCH_SIZE) {
          const batch = userAddresses.slice(i, i + BATCH_SIZE);

          // Query 1: Name stats per owner_address
          const nameStatsResult = await pool.query<{
            owner_address: string;
            name_count: string;
            digit_count: string;
            club_count: string;
            avg_years_remaining: string | null;
            avg_registration_year: string | null;
          }>(`
            SELECT
              owner_address,
              COUNT(*)::text as name_count,
              COUNT(*) FILTER (WHERE name ~ '^[0-9]+\\.eth$')::text as digit_count,
              COUNT(*) FILTER (WHERE array_length(clubs, 1) > 0)::text as club_count,
              AVG(EXTRACT(EPOCH FROM (expiry_date - NOW())) / (365.25 * 86400))::text as avg_years_remaining,
              AVG(EXTRACT(YEAR FROM registration_date))::text as avg_registration_year
            FROM ens_names
            WHERE owner_address = ANY($1)
              AND owner_address IS NOT NULL
            GROUP BY owner_address
          `, [batch]);

          const nameStatsMap = new Map<string, NameStats>();
          for (const row of nameStatsResult.rows) {
            nameStatsMap.set(row.owner_address, {
              name_count: parseInt(row.name_count, 10),
              digit_count: parseInt(row.digit_count, 10),
              club_count: parseInt(row.club_count, 10),
              avg_years_remaining: row.avg_years_remaining ? parseFloat(row.avg_years_remaining) : null,
              avg_registration_year: row.avg_registration_year ? parseFloat(row.avg_registration_year) : null,
            });
          }

          // Query 2: Trade stats per address from sales table
          const tradeStatsResult = await pool.query<{
            address: string;
            total_trades: string;
            recent_trades: string;
          }>(`
            SELECT
              address,
              COUNT(*)::text as total_trades,
              COUNT(*) FILTER (WHERE sale_date >= NOW() - INTERVAL '6 months')::text as recent_trades
            FROM (
              SELECT seller_address as address, sale_date FROM sales WHERE seller_address = ANY($1)
              UNION ALL
              SELECT buyer_address as address, sale_date FROM sales WHERE buyer_address = ANY($1)
            ) t
            GROUP BY address
          `, [batch]);

          const tradeStatsMap = new Map<string, TradeStats>();
          for (const row of tradeStatsResult.rows) {
            const recentTrades = parseInt(row.recent_trades, 10);
            tradeStatsMap.set(row.address, {
              total_trades: parseInt(row.total_trades, 10),
              trades_per_month: recentTrades / 6,
            });
          }

          // Query 3: Legend stats per minter_address
          const legendStatsResult = await pool.query<{
            minter_address: string;
            legend_count: string;
          }>(`
            SELECT minter_address, COUNT(*)::text as legend_count
            FROM legends
            WHERE minter_address = ANY($1)
            GROUP BY minter_address
          `, [batch]);

          const legendSet = new Set<string>();
          for (const row of legendStatsResult.rows) {
            if (parseInt(row.legend_count, 10) > 0) {
              legendSet.add(row.minter_address);
            }
          }

          // Score and classify each user in this batch
          const updates: Array<{ address: string; personaId: number; scores: Record<string, number> }> = [];

          for (const address of batch) {
            const nameStats = nameStatsMap.get(address);
            const tradeStats = tradeStatsMap.get(address);
            const isLegend = legendSet.has(address);

            const scores: Record<string, number> = {};

            for (const persona of personas) {
              if (persona.is_default) {
                scores[persona.slug] = 0.1;
                continue;
              }
              scores[persona.slug] = scorePersona(
                persona,
                nameStats ?? null,
                tradeStats ?? null,
                isLegend
              );
            }

            // Find winning persona: highest score above threshold, priority breaks ties
            let winningPersona = defaultPersona;
            let highestScore = 0;

            for (const persona of personas) {
              if (persona.is_default) continue;
              const score = scores[persona.slug];
              if (score >= MIN_SCORE_THRESHOLD && (
                score > highestScore ||
                (score === highestScore && persona.priority > winningPersona.priority)
              )) {
                highestScore = score;
                winningPersona = persona;
              }
            }

            updates.push({
              address,
              personaId: winningPersona.id,
              scores,
            });
          }

          // Batch update users
          if (updates.length > 0) {
            const values = updates.map((u, idx) => {
              const base = idx * 3;
              return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`;
            }).join(', ');

            const params = updates.flatMap(u => [u.address, u.personaId, JSON.stringify(u.scores)]);

            await pool.query(`
              UPDATE users SET
                persona_id = v.persona_id::int,
                persona_classified_at = NOW(),
                persona_scores = v.scores::jsonb
              FROM (VALUES ${values}) AS v(address, persona_id, scores)
              WHERE users.address = v.address
            `, params);
          }

          classified += batch.length;
          logger.info(
            { classified, total: userAddresses.length },
            'Persona classification batch completed'
          );
        }

        logger.info(
          { jobId: job.id, classified },
          'Persona classification completed'
        );

        return { success: true, classified };
      } catch (error) {
        logger.error({ jobId: job.id, err: error }, 'Persona classification failed');
        throw error;
      }
    }
  );

  await boss.schedule(QUEUE_NAME, CRON_SCHEDULE, {}, { tz: 'UTC' });

  logger.info(
    { queue: QUEUE_NAME, schedule: CRON_SCHEDULE },
    'Persona classification worker registered (daily, 4 AM UTC)'
  );
}

/**
 * Score a user for a specific persona based on its criteria.
 * Returns a value between 0.0 and 1.0.
 */
function scorePersona(
  persona: PersonaRow,
  nameStats: NameStats | null,
  tradeStats: TradeStats | null,
  isLegend: boolean
): number {
  const criteria = persona.criteria;

  switch (persona.slug) {
    case 'whale': {
      const minNames = (criteria.min_names as number) || 200;
      const count = nameStats?.name_count ?? 0;
      return Math.min(count / minNames, 1.0);
    }

    case 'og': {
      if (isLegend) return 1.0;
      const maxYear = (criteria.max_avg_registration_year as number) || 2019;
      const avgYear = nameStats?.avg_registration_year;
      if (avgYear == null || (nameStats?.name_count ?? 0) === 0) return 0;
      if (avgYear <= maxYear) return 1.0;
      // Linear interpolation: 2019 → 1.0, 2024 → 0.0
      const score = 1.0 - (avgYear - maxYear) / 5;
      return Math.max(0, Math.min(score, 1.0));
    }

    case 'digits': {
      const minNames = (criteria.min_names as number) || 5;
      const count = nameStats?.name_count ?? 0;
      if (count < minNames) return 0;
      const digitRatio = (nameStats?.digit_count ?? 0) / count;
      return digitRatio;
    }

    case 'trader': {
      const minTrades = (criteria.min_trades as number) || 10;
      const minTradesPerMonth = (criteria.min_trades_per_month as number) || 2;
      const totalTrades = tradeStats?.total_trades ?? 0;
      const tradesPerMonth = tradeStats?.trades_per_month ?? 0;
      const tradeScore = Math.min(totalTrades / minTrades, 1.0);
      const rateScore = Math.min(tradesPerMonth / minTradesPerMonth, 1.0);
      return (tradeScore + rateScore) / 2;
    }

    case 'lifer': {
      const minNames = (criteria.min_names as number) || 3;
      const minYears = (criteria.min_avg_years_remaining as number) || 8;
      const count = nameStats?.name_count ?? 0;
      if (count < minNames) return 0;
      const avgYears = nameStats?.avg_years_remaining ?? 0;
      return Math.min(Math.max(avgYears, 0) / minYears, 1.0);
    }

    case 'clubber': {
      const minNames = (criteria.min_names as number) || 5;
      const count = nameStats?.name_count ?? 0;
      if (count < minNames) return 0;
      const clubRatio = (nameStats?.club_count ?? 0) / count;
      return clubRatio;
    }

    case 'id': {
      const exactNames = (criteria.exact_names as number) || 1;
      const count = nameStats?.name_count ?? 0;
      return count === exactNames ? 1.0 : 0;
    }

    default:
      return 0;
  }
}
