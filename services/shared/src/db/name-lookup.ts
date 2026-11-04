/**
 * SQL subquery returning the ens_names.id for a name, matched case-insensitively.
 *
 * LOWER(name) matching alone can hit two rows: "jesse.eth" and "Jesse.eth" are
 * separate on-chain tokens (the registrar doesn't enforce normalization). This picks
 * one deterministically: the exact spelling first, then the lowercase row, then the
 * oldest id.
 *
 * @param param - placeholder for the name, e.g. '$1'
 *
 * @example
 * pool.query(`SELECT id FROM ens_names WHERE id = ${ensNameIdForName('$1')}`, [name])
 */
export function ensNameIdForName(param: string): string {
  const p = `${param}::text`;
  return `(SELECT id FROM ens_names WHERE LOWER(name) = LOWER(${p}) ORDER BY (name = ${p}) DESC, (name = LOWER(${p})) DESC, id LIMIT 1)`;
}
