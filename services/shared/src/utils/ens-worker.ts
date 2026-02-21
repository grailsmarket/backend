import { config } from '../config';

const BAD_RESOLVER = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';

/**
 * Determine if we need to fall back to the ENS worker for text records.
 *
 * Returns true when either:
 * 1. The resolver is the known Public Resolver v2 that only emits keys to The Graph
 * 2. The Graph returned text keys (`texts` array) but ALL `textChangeds` values are null/empty
 */
export function needsEnsWorkerFallback(
  resolverAddress: string | null | undefined,
  texts: string[] | null | undefined,
  textChangeds: Array<{ key: string; value: string | null }> | null | undefined,
): boolean {
  // Check for the known bad resolver
  if (resolverAddress && resolverAddress.toLowerCase() === BAD_RESOLVER) {
    return true;
  }

  // Generic detection: texts array has entries but all textChangeds values are empty
  if (texts && texts.length > 0) {
    if (!textChangeds || textChangeds.length === 0) {
      return true;
    }
    const hasAnyValue = textChangeds.some(
      (r) => r.value != null && r.value !== '',
    );
    if (!hasAnyValue) {
      return true;
    }
  }

  return false;
}

/**
 * Fetch text records for an ENS name from the ENS worker (on-chain resolution).
 *
 * Returns a flat Record<string, string> of text record key/value pairs.
 */
export async function fetchTextRecordsFromEnsWorker(
  name: string,
): Promise<Record<string, string>> {
  const url = `${config.theGraph.ensWorkerUrl}/u/${name}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(
      `ENS worker request failed for ${name}: ${response.status} ${response.statusText}`,
    );
  }

  const json: any = await response.json();

  const records: Record<string, string> = {};
  if (json.records && typeof json.records === 'object') {
    for (const [key, value] of Object.entries(json.records)) {
      if (value != null && value !== '') {
        records[key] = value as string;
      }
    }
  }

  return records;
}
