// 'any' is the pre-multi-select name for 'all'; older clients still send it.
const LEGACY_ALIASES: Record<string, string> = { any: 'all' };

export function parseClubsFilter(...raw: Array<string | string[] | undefined>): string[] {
  return raw
    .flat()
    .filter((club): club is string => typeof club === 'string')
    .flatMap(club => club.split(','))
    .map(club => club.trim())
    .filter(Boolean)
    .map(club => LEGACY_ALIASES[club] ?? club);
}

export function buildClubsCondition(clubs: string[], params: unknown[]): string {
  const named = clubs.filter(club => club !== 'none');
  const conditions: string[] = [];
  if (clubs.includes('none')) conditions.push(`en.clubs IS NULL OR en.clubs = '{}'`);
  if (clubs.includes('all')) {
    conditions.push('array_length(en.clubs, 1) > 0');
  } else if (named.length > 0) {
    params.push(named);
    conditions.push(`en.clubs && $${params.length}::text[]`);
  }
  return `(${conditions.join(' OR ')})`;
}
