const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Length of a name's label (without ".eth") in visible characters: graphemes, so 👱‍♂ and 1⃣
 * count as one. JavaScript's .length counts UTF-16 units (👱‍♂ is 5) and Postgres LENGTH()
 * counts code points (👱‍♂ is 4). This is the count stored as `character_count` in
 * Elasticsearch and used by the length filter and sort.
 */
export function nameCharacterCount(name: string): number {
  const label = name.endsWith('.eth') ? name.slice(0, -4) : name;
  let count = 0;
  for (const _ of graphemeSegmenter.segment(label)) count++;
  return count;
}
