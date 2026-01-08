/**
 * Audit ENS Name Normalization
 *
 * Scans all ens_names records and identifies normalization issues:
 * - Names that need normalization (valid but not in canonical form)
 * - Invalid names that fail ENSIP-15 normalization
 * - Duplicates that would exist after normalization
 *
 * Usage:
 *   npx ts-node src/scripts/audit-ens-normalization.ts [--verbose] [--output=json] [--limit=N]
 */

import { getPostgresPool, normalizeEnsName, isPlaceholderName } from '../../../shared/src';

const BATCH_SIZE = 1000;
const VERBOSE = process.argv.includes('--verbose');
const OUTPUT_JSON = process.argv.includes('--output=json');

let LIMIT = 0;
const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
if (limitArg) {
  LIMIT = parseInt(limitArg.split('=')[1]);
}

interface AuditRecord {
  id: number;
  name: string;
  tokenId: string;
  ownerAddress: string;
  normalizedName: string | null;
  issue: 'needs_normalization' | 'invalid' | 'placeholder';
  error?: string;
}

interface DuplicateGroup {
  normalizedName: string;
  /** True if names are different strings that normalize to the same value */
  isNormalizationConflict: boolean;
  records: Array<{
    id: number;
    name: string;
    tokenId: string;
    ownerAddress: string;
  }>;
}

interface AuditSummary {
  totalRecords: number;
  placeholders: number;
  alreadyNormalized: number;
  needsNormalization: number;
  invalid: number;
  /** Groups where the exact same name string appears with different token_ids */
  exactDuplicates: number;
  /** Groups where different name strings normalize to the same value */
  normalizationConflicts: number;
  duplicateGroups: DuplicateGroup[];
}

async function auditEnsNormalization() {
  const pool = getPostgresPool();

  if (!OUTPUT_JSON) {
    console.log('=== ENS Name Normalization Audit ===\n');
  }

  // Get total count
  const countResult = await pool.query('SELECT COUNT(*) FROM ens_names');
  const totalCount = parseInt(countResult.rows[0].count);

  if (!OUTPUT_JSON) {
    console.log(`Total records in ens_names: ${totalCount}`);
    if (LIMIT > 0) console.log(`Limiting to: ${LIMIT} records`);
    console.log('');
  }

  const issues: AuditRecord[] = [];
  const normalizedToRecords = new Map<string, Array<{ id: number; name: string; tokenId: string; ownerAddress: string }>>();

  let processed = 0;
  let placeholders = 0;
  let alreadyNormalized = 0;
  let needsNormalization = 0;
  let invalid = 0;

  const effectiveLimit = LIMIT > 0 ? LIMIT : totalCount;

  // Process in batches
  let offset = 0;
  while (offset < effectiveLimit) {
    const batchLimit = Math.min(BATCH_SIZE, effectiveLimit - offset);

    const result = await pool.query(`
      SELECT id, name, token_id, owner_address
      FROM ens_names
      ORDER BY id
      LIMIT $1 OFFSET $2
    `, [batchLimit, offset]);

    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      const { id, name, token_id: tokenId, owner_address: ownerAddress } = row;

      // Check for placeholder
      if (isPlaceholderName(name)) {
        placeholders++;
        processed++;
        continue;
      }

      // Normalize the name
      const normResult = normalizeEnsName(name);

      if (!normResult.isValid) {
        invalid++;
        issues.push({
          id,
          name,
          tokenId,
          ownerAddress,
          normalizedName: null,
          issue: 'invalid',
          error: normResult.error,
        });

        if (VERBOSE && !OUTPUT_JSON) {
          console.log(`[INVALID] id=${id} name="${name}" error="${normResult.error}"`);
        }
      } else if (!normResult.wasAlreadyNormalized) {
        needsNormalization++;
        issues.push({
          id,
          name,
          tokenId,
          ownerAddress,
          normalizedName: normResult.normalized,
          issue: 'needs_normalization',
        });

        if (VERBOSE && !OUTPUT_JSON) {
          console.log(`[NORMALIZE] id=${id} "${name}" → "${normResult.normalized}"`);
        }

        // Track for duplicate detection
        const normalized = normResult.normalized!;
        if (!normalizedToRecords.has(normalized)) {
          normalizedToRecords.set(normalized, []);
        }
        normalizedToRecords.get(normalized)!.push({ id, name, tokenId, ownerAddress });
      } else {
        alreadyNormalized++;

        // Also track normalized names to detect duplicates
        if (!normalizedToRecords.has(name)) {
          normalizedToRecords.set(name, []);
        }
        normalizedToRecords.get(name)!.push({ id, name, tokenId, ownerAddress });
      }

      processed++;
    }

    offset += result.rows.length;

    if (!OUTPUT_JSON) {
      const pct = Math.round((processed / effectiveLimit) * 100);
      process.stdout.write(`\rProgress: ${processed}/${effectiveLimit} (${pct}%) | Placeholders: ${placeholders} | Normalized: ${alreadyNormalized} | Needs fix: ${needsNormalization} | Invalid: ${invalid}`);
    }
  }

  if (!OUTPUT_JSON) {
    console.log('\n');
  }

  // Find duplicates (names that normalize to the same value)
  const duplicateGroups: DuplicateGroup[] = [];
  for (const [normalizedName, records] of normalizedToRecords.entries()) {
    if (records.length > 1) {
      // Check if all records have the exact same name string
      const uniqueNames = new Set(records.map(r => r.name));
      const isNormalizationConflict = uniqueNames.size > 1;
      duplicateGroups.push({ normalizedName, isNormalizationConflict, records });
    }
  }

  const exactDuplicates = duplicateGroups.filter(g => !g.isNormalizationConflict).length;
  const normalizationConflicts = duplicateGroups.filter(g => g.isNormalizationConflict).length;

  const summary: AuditSummary = {
    totalRecords: processed,
    placeholders,
    alreadyNormalized,
    needsNormalization,
    invalid,
    exactDuplicates,
    normalizationConflicts,
    duplicateGroups: duplicateGroups.slice(0, 100), // Limit for output
  };

  if (OUTPUT_JSON) {
    console.log(JSON.stringify({
      summary,
      issues: issues.slice(0, 1000), // Limit for output
    }, null, 2));
  } else {
    console.log('=== Summary ===');
    console.log(`Total records processed: ${summary.totalRecords}`);
    console.log(`Placeholders (skipped): ${summary.placeholders}`);
    console.log(`Already normalized: ${summary.alreadyNormalized}`);
    console.log(`Needs normalization: ${summary.needsNormalization}`);
    console.log(`Invalid names: ${summary.invalid}`);
    console.log(`Exact duplicates (same name, different token_id): ${summary.exactDuplicates}`);
    console.log(`Normalization conflicts (different names → same normalized): ${summary.normalizationConflicts}`);

    if (summary.needsNormalization > 0) {
      console.log('\n=== Sample: Names Needing Normalization ===');
      const needsNormSamples = issues.filter(i => i.issue === 'needs_normalization').slice(0, 20);
      for (const record of needsNormSamples) {
        console.log(`  id=${record.id}: "${record.name}" → "${record.normalizedName}"`);
      }
      if (summary.needsNormalization > 20) {
        console.log(`  ... and ${summary.needsNormalization - 20} more`);
      }
    }

    if (summary.invalid > 0) {
      console.log('\n=== Sample: Invalid Names ===');
      const invalidSamples = issues.filter(i => i.issue === 'invalid').slice(0, 20);
      for (const record of invalidSamples) {
        console.log(`  id=${record.id}: "${record.name}" - ${record.error}`);
      }
      if (summary.invalid > 20) {
        console.log(`  ... and ${summary.invalid - 20} more`);
      }
    }

    const conflictGroups = duplicateGroups.filter(g => g.isNormalizationConflict);
    const exactDupGroups = duplicateGroups.filter(g => !g.isNormalizationConflict);

    if (conflictGroups.length > 0) {
      console.log('\n=== Normalization Conflicts (different names → same normalized) ===');
      for (const group of conflictGroups.slice(0, 15)) {
        console.log(`  "${group.normalizedName}":`);
        for (const record of group.records) {
          console.log(`    - id=${record.id} name="${record.name}" token_id=${record.tokenId.slice(0, 20)}...`);
        }
      }
      if (conflictGroups.length > 15) {
        console.log(`  ... and ${conflictGroups.length - 15} more conflict groups`);
      }
    }

    if (exactDupGroups.length > 0) {
      console.log('\n=== Exact Duplicates (same name, different token_id) ===');
      for (const group of exactDupGroups.slice(0, 10)) {
        console.log(`  "${group.normalizedName}":`);
        for (const record of group.records) {
          console.log(`    - id=${record.id} token_id=${record.tokenId.slice(0, 20)}...`);
        }
      }
      if (exactDupGroups.length > 10) {
        console.log(`  ... and ${exactDupGroups.length - 10} more exact duplicate groups`);
      }
    }
  }

  await pool.end();
  return summary;
}

auditEnsNormalization()
  .then((summary) => {
    if (!OUTPUT_JSON) {
      console.log('\nAudit complete.');
      if (summary.needsNormalization > 0 || summary.invalid > 0 || summary.normalizationConflicts > 0) {
        console.log('\nAction required: Run fix-ens-normalization.ts to resolve issues.');
      }
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error('Audit failed:', error);
    process.exit(1);
  });
