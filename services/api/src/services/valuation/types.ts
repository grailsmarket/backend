import type { Address } from 'viem';

export type ValuationEvidenceRequest = {
  recommendationCount?: number;
  premiumRegistrationFloorEth?: string;
};

export const VALUATION_PROGRESS_STAGE_LABELS = {
  checking_eligibility: 'Checking eligibility',
  measuring_web2_footprint: 'Measuring Web2 footprint',
  researching_name_context: 'Researching name context',
  looking_for_comparable_sales: 'Looking for comparable sales',
  writing_valuation_estimate: 'Processing valuation',
} as const;

export type ValuationProgressStage = keyof typeof VALUATION_PROGRESS_STAGE_LABELS;

export const VALUATION_PROGRESS_STAGES = [
  'checking_eligibility',
  'measuring_web2_footprint',
  'researching_name_context',
  'looking_for_comparable_sales',
  'writing_valuation_estimate',
] as const satisfies readonly ValuationProgressStage[];

export type ValuationProgressStageStatus = 'started' | 'completed' | 'skipped';

export type ValuationEvidenceStreamStageEvent = {
  type: 'stage';
  stage: ValuationProgressStage;
  label: (typeof VALUATION_PROGRESS_STAGE_LABELS)[ValuationProgressStage];
  status: ValuationProgressStageStatus;
  message?: string;
  elapsedMs: number;
  timestamp: string;
};

export type ValuationEvidenceStreamResultEvent = {
  type: 'result';
  data: ValuationEvidenceResult;
};

export type ValuationEvidenceStreamErrorEvent = {
  type: 'error';
  status: number;
  error: {
    code: string;
    message: string;
  };
};

export type ValuationEvidenceStreamEvent =
  | ValuationEvidenceStreamStageEvent
  | ValuationEvidenceStreamResultEvent
  | ValuationEvidenceStreamErrorEvent;

export type ValuationSenseTerms = {
  senseIdx: number;
  sense: string;
  demandScore: number;
  requested: number;
  returned: number;
  terms: string[];
  error?: string;
};

export type ValuationRelatedTermsEvidence = {
  source: 'ai_scoped_senses' | 'skipped_web2_footprint_gate';
  model: string | null;
  senseCount: number;
  perSense: ValuationSenseTerms[];
  /** Normalized term -> indices of the senses that generated it. */
  termSenses: Record<string, number[]>;
  baseTermCount: number;
  numberVariantCount: number;
  validCount: number;
  baseTerms: string[];
  numberVariants: string[];
  terms: string[];
  skipped?: boolean;
  skipReason?: 'web2_footprint_below_threshold';
  skipMessage?: string;
};

export type ValuationActivitySale = {
  id: number;
  ens_name_id: number;
  event_type: string;
  actor_address: Address | string | null;
  counterparty_address: Address | string | null;
  platform: string | null;
  chain_id: number;
  price_wei: string | null;
  currency_address: Address | string | null;
  transaction_hash: string | null;
  block_number: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  name: string;
  token_id: string;
  clubs: string[] | null;
};

export type ValuationMintEvent = ValuationActivitySale & {
  metadata: ValuationActivitySale['metadata'] & {
    base_cost_wei?: string;
    premium_wei?: string;
    total_cost_wei?: string;
    duration_seconds?: number;
    referrer?: string;
    registration_source?: string | null;
  };
};

export type ValuationActivityError = {
  term: string;
  eventType: 'sold' | 'mint' | 'combined';
  status: number;
  code?: string;
  message: string;
  rateLimited: boolean;
};

export type ValuationMarketActivityEvidence = {
  summary: {
    termsChecked: number;
    termsWithSales: number;
    salesFound: number;
    salesFloorWei: string;
    lowValueSalesExcluded: number;
    termsWithMintEvents: number;
    mintEventsFound: number;
    termsWithPremiumRegistrations: number;
    premiumRegistrationsFound: number;
    premiumRegistrationFloorWei: string;
    activityErrorsFound: number;
    rateLimited: boolean;
    termsSkippedAfterRateLimit: number;
    targetNameEventsExcluded: number;
    skipped: boolean;
    skipReason?: 'web2_footprint_below_threshold';
    skipMessage?: string;
  };
  sales: ValuationActivitySale[];
  mintEvents: ValuationMintEvent[];
  premiumRegistrations: ValuationMintEvent[];
  errors: ValuationActivityError[];
};

export type ValuationDomDbPronounceability = {
  locale: string | null;
  score: number | null;
};

export type ValuationDomDbRegisteredExtension = {
  extension: string;
  availability: string | null;
  popularity: number | null;
};

export type ValuationDomDbTopExtensionCoverage = {
  extension: string;
  registered: boolean;
};

export type ValuationWeb2Evidence = {
  source: 'domdb' | 'domdb_empty';
  lookupDomain: string;
  summary: {
    registeredExtensions: number;
    topExtensionsRegistered: number;
    topExtensionsChecked: number;
    pronounceabilityScore: number | null;
    pronounceabilityLocale: string | null;
  };
  domdb: {
    domain: string | null;
    availability: string | null;
    registryPremium: boolean | null;
    pronounceability: ValuationDomDbPronounceability[];
    registeredExtensions: ValuationDomDbRegisteredExtension[];
    topExtensionCoverage: ValuationDomDbTopExtensionCoverage[];
  } | null;
};

export type ValuationSearchDemandEvidence = {
  source: 'grails_google_metrics';
  keyword: string;
  eligible: true;
  dataStatus: 'available' | 'no_data' | 'error';
  note?: string;
  summary: {
    avgMonthlySearches: number | null;
    estimatedYearlySearches: number | null;
    avgCpc: number | null;
    monthlyTrendPoints: number;
  };
  monthlyTrend: { month: string; year: number; searches: number }[];
  error?: {
    status?: number;
    code?: string;
    message: string;
  };
};

export type ValuationResearchSense = {
  sense: string;
  /** 1-5: how likely a domain buyer is to want the name FOR this sense. */
  demandScore: number;
};

export type ValuationNameResearchEvidence = {
  source: 'openai_web_search';
  model: string;
  dataStatus: 'available' | 'error';
  generatedAt: string;
  label: string;
  categories: string[];
  /** Distinct senses ordered by domain-buyer demand (most valuable first). */
  senses: ValuationResearchSense[];
  /** Sense texts only, kept for downstream consumers/logging. */
  meanings: string[];
  error?: {
    message: string;
  };
};

export type ValuationAppraisalEvidence = {
  source: 'openai_full_evidence_appraisal';
  model: string;
  dataStatus: 'available' | 'error';
  generatedAt: string;
  ethValue: string;
  lowEth: string;
  highEth: string;
  reasoning: string;
  signals: string[];
  cautions: string[];
  compsUsed: Array<{
    name: string;
    priceEth: string;
    date: string;
  }>;
  error?: {
    message: string;
  };
};

export type ValuationCategoryContextEvidence = {
  source: 'grails_name_endpoint';
  summary: {
    categoriesFound: number;
    rankedCategories: number;
    commentsFound: number;
  };
  categories: Array<{
    slug: string;
    rank: number | null;
    comments: string[];
  }>;
};

export type ValuationCategoryMarketActivityEvidence = {
  source: 'grails_category_activity';
  scope: 'category_membership_market_activity';
  note: string;
  summary: {
    categoriesChecked: number;
    categoriesSkipped: number;
    eventsFound: number;
    salesFound: number;
    mintEventsFound: number;
    errorsFound: number;
    targetNameEventsExcluded: number;
  };
  skippedCategories: Array<{
    slug: string;
    reason: 'ignored_category';
  }>;
  categories: Array<{
    slug: string;
    eventsFound: number;
    salesFound: number;
    mintEventsFound: number;
    targetNameEventsExcluded: number;
    sales: ValuationActivitySale[];
    mintEvents: ValuationMintEvent[];
    errors: ValuationActivityError[];
  }>;
};

export type ValuationCalibrationContextEvidence = {
  source: 'derived_calibration_v1';
  searchDemand: {
    avgMonthlySearches: {
      counterSignalBelow: number;
      meaningfulAt: number;
      strongAt: number;
      exceptionalAt: number;
    };
    avgCpc: {
      meaningfulAt: number;
      strongAt: number;
      exceptionalAt: number;
    };
    notes: string[];
  };
  web2Footprint: {
    registeredExtensions: {
      tooObscureBelow: number;
      meaningfulAt: number;
      strongAt: number;
      exceptionalAt: number;
    };
    topExtensionsRegistered: {
      max: number;
      meaningfulAt: number;
      strongAt: number;
      exceptionalAt: number;
    };
    pronounceability: {
      meaningfulAt: number;
      strongAt: number;
      exceptionalAt: number;
    };
    compsGate: 'passed' | 'skipped';
    notes: string[];
  };
  categoryPremiums: Array<{
    category: string;
    rank: number | null;
    notes: string[];
  }>;
};

export type ValuationEvidence = {
  relatedTerms: ValuationRelatedTermsEvidence;
  marketActivity: ValuationMarketActivityEvidence;
  web2: ValuationWeb2Evidence;
  searchDemand: ValuationSearchDemandEvidence;
  nameResearch: ValuationNameResearchEvidence;
  categoryContext: ValuationCategoryContextEvidence;
  categoryMarketActivity: ValuationCategoryMarketActivityEvidence;
  calibrationContext: ValuationCalibrationContextEvidence;
  appraisal: ValuationAppraisalEvidence;
};

export type ValuationEvidenceResult = {
  name: string;
  status: 'completed';
  evidence: ValuationEvidence;
  generatedAt: string;
};
