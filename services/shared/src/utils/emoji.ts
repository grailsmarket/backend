/**
 * Comprehensive emoji detection regex
 *
 * Covers all major emoji Unicode blocks:
 * - U+1F600-U+1F64F: Emoticons
 * - U+1F300-U+1F5FF: Misc Symbols and Pictographs
 * - U+1F680-U+1F6FF: Transport and Map Symbols
 * - U+1F1E0-U+1F1FF: Regional Indicator Symbols (Flags)
 * - U+1F900-U+1F9FF: Supplemental Symbols and Pictographs (includes 🦖, 🦁, etc.)
 * - U+1FA00-U+1FAFF: Symbols and Pictographs Extended-A
 * - U+2600-U+26FF: Miscellaneous Symbols
 * - U+2700-U+27BF: Dingbats
 */
export const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;

/**
 * Check if a string contains any emoji characters
 */
export function hasEmoji(str: string): boolean {
  return EMOJI_REGEX.test(str);
}
