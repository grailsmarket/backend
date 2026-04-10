/**
 * Comprehensive emoji detection regex
 *
 * Uses Unicode property escapes for maintainable, complete coverage:
 * - \p{Emoji_Presentation}: Characters with default emoji presentation (most standard emoji)
 * - \p{Emoji}\uFE0F: Text characters rendered as emoji via variation selector-16
 * - \u20E3: Combining Enclosing Keycap (for keycap sequences like 3⃣, #⃣)
 */
export const EMOJI_REGEX = /\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\u20E3/u;

/**
 * Check if a string contains any emoji characters
 */
export function hasEmoji(str: string): boolean {
  return EMOJI_REGEX.test(str);
}
