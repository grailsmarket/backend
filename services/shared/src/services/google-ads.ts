import { config } from '../config';

export interface KeywordMetricsResponse {
  avgMonthlySearches: number | null;
  avgCpc: number | null;
  monthlyTrend: { month: string; year: number; searches: number }[];
  competition: string | null;
}

interface MonthlyVolume {
  month: string;
  year: string;
  monthlySearches: string;
}

const GOOGLE_MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

function getTrailing12MonthRange() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const start = new Date(end.getFullYear(), end.getMonth() - 23, 1);
  return {
    start: { year: start.getFullYear(), month: GOOGLE_MONTH_NAMES[start.getMonth()] },
    end: { year: end.getFullYear(), month: GOOGLE_MONTH_NAMES[end.getMonth()] },
  };
}

async function getAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = config.googleAds;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId!,
      client_secret: clientSecret!,
      refresh_token: refreshToken!,
      grant_type: 'refresh_token',
    }),
  });

  const data: any = await response.json();
  if (data.error) {
    throw new Error(`Token error: ${data.error_description}`);
  }
  return data.access_token;
}

async function getKeywordHistoricalMetrics(
  keyword: string,
  accessToken: string,
): Promise<{
  avgMonthlySearches: number | null;
  avgCpc: number | null;
  monthlyTrend: MonthlyVolume[];
  competition: string | null;
}> {
  const { customerId, developerToken } = config.googleAds;

  const response = await fetch(
    `https://googleads.googleapis.com/v22/customers/${customerId}:generateKeywordHistoricalMetrics`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': developerToken!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        keywords: [keyword],
        keywordPlanNetwork: 'GOOGLE_SEARCH',
        historicalMetricsOptions: {
          yearMonthRange: getTrailing12MonthRange(),
          includeAverageCpc: true,
        },
      }),
    },
  );

  const data: any = await response.json();

  if (data.error) {
    console.error('[google-ads] API error (metrics):', data.error?.message ?? data.error);
    return { avgMonthlySearches: null, avgCpc: null, monthlyTrend: [], competition: null };
  }

  const result = data.results?.[0];
  const metrics = result?.keywordMetrics || {};
  const rawVolumes = metrics.monthlySearchVolumes;

  const monthlyTrend: MonthlyVolume[] = Array.isArray(rawVolumes)
    ? rawVolumes.filter(
        (m: unknown): m is MonthlyVolume =>
          typeof m === 'object' &&
          m !== null &&
          typeof (m as MonthlyVolume).month === 'string' &&
          typeof (m as MonthlyVolume).year === 'string' &&
          typeof (m as MonthlyVolume).monthlySearches === 'string',
      )
    : [];

  const avgCpc = metrics.averageCpcMicros
    ? Math.round(parseInt(metrics.averageCpcMicros) / 10_000) / 100
    : null;

  return {
    avgMonthlySearches: metrics.avgMonthlySearches ? parseInt(metrics.avgMonthlySearches) : null,
    avgCpc,
    monthlyTrend,
    competition: metrics.competition || null,
  };
}

async function getRelatedKeywordCount(keyword: string, accessToken: string): Promise<number> {
  const { customerId, developerToken } = config.googleAds;

  const response = await fetch(
    `https://googleads.googleapis.com/v22/customers/${customerId}:generateKeywordIdeas`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': developerToken!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        keywordSeed: { keywords: [keyword] },
        keywordPlanNetwork: 'GOOGLE_SEARCH',
      }),
    },
  );

  const data: any = await response.json();

  if (data.error) {
    console.error('[google-ads] API error (ideas):', data.error?.message ?? data.error);
    return 0;
  }

  return data.results?.length || 0;
}

/**
 * Fetch keyword metrics from Google Ads API.
 *
 * Returns null on any failure (missing credentials, API error, etc.)
 * following the same error pattern as openai.ts.
 */
export async function fetchKeywordMetrics(
  keyword: string,
): Promise<KeywordMetricsResponse | null> {
  const { developerToken, clientId, clientSecret, refreshToken, customerId } = config.googleAds;

  if (!developerToken || !clientId || !clientSecret || !refreshToken || !customerId) {
    console.error('[google-ads] Missing Google Ads credentials — cannot fetch keyword metrics');
    return null;
  }

  try {
    const accessToken = await getAccessToken();

    const metricsResult = await getKeywordHistoricalMetrics(keyword, accessToken);

    const monthlyTrend = metricsResult.monthlyTrend.map((m) => ({
      month: m.month,
      year: parseInt(m.year),
      searches: parseInt(m.monthlySearches) || 0,
    }));

    return {
      avgMonthlySearches: metricsResult.avgMonthlySearches,
      avgCpc: metricsResult.avgCpc,
      monthlyTrend,
      competition: metricsResult.competition,
    };
  } catch (error) {
    console.error('[google-ads] Error fetching keyword metrics:', error);
    return null;
  }
}
