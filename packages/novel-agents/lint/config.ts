/**
 * Prose-Lint thresholds. Centralized so recalibration never touches rule logic.
 * Conservative by design: false positives erode agent trust faster than missed nits.
 */
export const LINT_CONFIG = {
  chapterText: {
    /** Below this the chapter likely got truncated mid-generation. */
    minWords: 200,
    /** Frontmatter word_count may deviate from the actual body by at most this ratio. */
    declaredDeviationRatio: 0.2,
  },
  storySummary: {
    maxWords: 2500,
  },
  repetition: {
    minLength: 16,
    minOccurrences: 3,
    maxSpan: 200,
    maxFindings: 5,
    /** A flagged snippet must contain at least this many CJK chars, skipping separators/rules. */
    minCjkChars: 2,
  },
  bannedPhrases: {
    maxFindings: 8,
  },
  endingSummary: {
    /** Only the tail of the final paragraph is scanned, capped at this many chars. */
    tailChars: 120,
  },
  /** Doc types treated as narrative prose for cliché/repetition scans. */
  narrativeTypes: new Set(["chapter-text", "director-script", "story-summary"]),
} as const;
