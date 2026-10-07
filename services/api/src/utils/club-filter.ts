export function parseClubsFilter(raw: string | string[] = []): string[] {
  return [raw].flat().flatMap(club => club.split(',')).map(club => club.trim()).filter(Boolean);
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
