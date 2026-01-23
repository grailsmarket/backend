import { stringify } from 'csv-stringify';
import { SearchResult, Listing } from './response-builder';
import { Pool } from 'pg';

export const MAX_EXPORT_ROWS = 10000;

export const CSV_HEADERS = [
  'id',
  'name',
  'token_id',
  'owner_address',
  'expiry_date',
  'status',
  'list_price',
  'registration_date',
  'clubs',
  'view_count',
];

interface ExportRow {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
  expiry_date: Date | null;
  status: string;
  list_price: string | null;
  registration_date: Date | null;
  clubs: string[] | null;
  view_count: number;
}

/**
 * Fetch export data directly from PostgreSQL (lightweight, fast query)
 * Returns data in the same order as the input names array
 */
export async function fetchExportData(
  pool: Pool,
  names: string[]
): Promise<ExportRow[]> {
  if (names.length === 0) {
    return [];
  }

  // Build placeholder list for IN clause
  const placeholders = names.map((_, i) => `$${i + 1}`).join(',');

  // Lightweight query - only fetches what's needed for CSV export
  const query = `
    SELECT
      en.id,
      en.name,
      en.token_id,
      en.owner_address,
      en.expiry_date,
      en.registration_date,
      en.clubs,
      COALESCE(en.view_count, 0) as view_count,
      MIN(CASE WHEN l.status = 'active' THEN l.price_wei END) as list_price,
      CASE
        WHEN en.expiry_date IS NULL THEN 'registered'
        WHEN en.expiry_date > NOW() THEN 'registered'
        WHEN en.expiry_date > NOW() - INTERVAL '90 days' THEN 'grace'
        WHEN en.expiry_date > NOW() - INTERVAL '111 days' THEN 'premium'
        ELSE 'available'
      END as status
    FROM ens_names en
    LEFT JOIN listings l ON l.ens_name_id = en.id
    WHERE LOWER(en.name) IN (${placeholders})
    GROUP BY en.id
  `;

  const result = await pool.query(query, names.map(n => n.toLowerCase()));

  // Create a map for ordering
  const dataMap = new Map<string, ExportRow>();
  for (const row of result.rows) {
    dataMap.set(row.name.toLowerCase(), {
      id: row.id,
      name: row.name,
      token_id: row.token_id,
      owner_address: row.owner_address,
      expiry_date: row.expiry_date,
      status: row.status,
      list_price: row.list_price,
      registration_date: row.registration_date,
      clubs: row.clubs,
      view_count: row.view_count,
    });
  }

  // Return results in the same order as input names
  const orderedResults: ExportRow[] = [];
  for (const name of names) {
    const row = dataMap.get(name.toLowerCase());
    if (row) {
      orderedResults.push(row);
    }
  }

  return orderedResults;
}

/**
 * Convert export rows to CSV format
 */
export async function exportRowsToCSV(rows: ExportRow[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const csvStringifier = stringify({
      header: true,
      columns: CSV_HEADERS,
    });

    const chunks: string[] = [];
    csvStringifier.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    csvStringifier.on('finish', () => resolve(chunks.join('')));
    csvStringifier.on('error', reject);

    for (const row of rows) {
      csvStringifier.write([
        row.id,
        row.name,
        row.token_id,
        row.owner_address,
        row.expiry_date ? row.expiry_date.toISOString() : '',
        row.status,
        row.list_price || '',
        row.registration_date ? row.registration_date.toISOString() : '',
        Array.isArray(row.clubs) ? row.clubs.join(',') : '',
        row.view_count,
      ]);
    }

    csvStringifier.end();
  });
}

/**
 * Compute ENS registration status from expiry date
 */
export function computeStatus(expiryDate: Date | null): string {
  if (!expiryDate) return 'registered';

  const now = new Date();
  const daysSinceExpiry = (now.getTime() - expiryDate.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceExpiry < 0) return 'registered';
  if (daysSinceExpiry <= 90) return 'grace';
  if (daysSinceExpiry <= 111) return 'premium';
  return 'available';
}

/**
 * Convert search results to CSV format (slower, uses full SearchResult objects)
 */
export async function resultsToCSV(results: SearchResult[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const csvStringifier = stringify({
      header: true,
      columns: CSV_HEADERS,
    });

    const chunks: string[] = [];
    csvStringifier.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    csvStringifier.on('finish', () => resolve(chunks.join('')));
    csvStringifier.on('error', reject);

    for (const result of results) {
      // Get lowest active listing price
      const activeListings = result.listings?.filter(l => l.status === 'active') || [];
      const lowestPrice = activeListings.length > 0
        ? activeListings.reduce((min, l) => {
            const price = BigInt(l.price || '0');
            return price < min ? price : min;
          }, BigInt(activeListings[0].price || '0')).toString()
        : '';

      csvStringifier.write([
        result.id,
        result.name,
        result.token_id,
        result.owner,
        result.expiry_date ? new Date(result.expiry_date).toISOString() : '',
        computeStatus(result.expiry_date ? new Date(result.expiry_date) : null),
        lowestPrice,
        result.registration_date ? new Date(result.registration_date).toISOString() : '',
        Array.isArray(result.clubs) ? result.clubs.join(',') : '',
        result.view_count || 0,
      ]);
    }

    csvStringifier.end();
  });
}
