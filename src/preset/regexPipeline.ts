/**
 * Non-stream regex pipeline: applies a set of regex rules to a text string.
 *
 * Used for:
 * - Visible assistant content (all 4 rules)
 * - History message preprocessing (strip_thinking only)
 *
 * Each rule's regex is cloned with the global flag to avoid stateful
 * lastIndex issues when the same rule is applied to multiple texts.
 */

import type { RegexRule } from "./regexRules";

/**
 * Apply a list of regex rules to text, in order.
 * Returns the filtered text. Empty string if all content was stripped.
 */
export function applyRegexRules(
  text: string,
  rules: readonly RegexRule[]
): string {
  let result = text;
  for (const rule of rules) {
    // Clone the regex to reset lastIndex (rules are defined with /g flag).
    result = result.replace(new RegExp(rule.find.source, rule.find.flags), rule.replace);
  }
  return result;
}
