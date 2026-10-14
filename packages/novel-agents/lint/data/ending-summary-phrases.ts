/**
 * Curated markers of "chapter ends on a summary/moralizing beat" — the
 * opposite of ending pull (章末拉力). Scanned only against the tail of the
 * final paragraph of chapter-text documents. Data, not logic: reviewer-curated
 * (see verifier-stack spec ADR-5); deliberately conservative — an ending that
 * merely shows quiet aftermath (余韵) is legal, only explicit tell-not-show
 * wraps belong here.
 */
export const ENDING_SUMMARY_PHRASES: readonly string[] = [
  "总之",
  "终于明白了",
  "明白了一个道理",
  "这就是所谓",
  "一切都不一样了",
  "一切都变了",
  "这一夜，注定",
  "注定不平凡",
  "百感交集",
  "感慨万千",
  "久久不能平静",
  "难以平静",
];
