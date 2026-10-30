const RUN = /([㐀-鿿぀-ヿ豈-﫿]+)|([a-z0-9_]+)/g;

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * Function characters: sentence particles, pronouns, and the common verbs,
 * adverbs and particles of Chinese and Japanese. They appear in almost every
 * message, so as unigrams they match everything and drown the real words.
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "的 了 嗎 啊 呢 吧 是 我 你 他 在 有 就 都 也 " +
    "啦 嘛 喔 哦 唔 欸 " +
    "不 一 好 很 這 那 說 想 要 會 去 來 到 和 跟 但 還 又 才 沒 為 什 麼 " +
    "她 它 們 個 著 過 被 把 讓 對 " +
    "呀 哈 嗯 " +
    "の は を が に で と も"
  ).split(" "),
);

/** A small English list: articles, copulas, pronouns and prepositions. */
export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set(
  "a an is are was were be to of and or in on at it this that i you he she we they".split(" "),
);

export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (token: string): void => {
    if (token.length === 0 || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };

  for (const match of text.toLowerCase().matchAll(RUN)) {
    const cjk = match[1];
    if (cjk !== undefined) {
      // Word segments are real words, so only drop ones made of nothing but particles.
      for (const part of segmenter.segment(cjk)) {
        if (part.isWordLike !== true) continue;
        const chars = Array.from(part.segment);
        if (chars.every((c) => STOPWORDS.has(c))) continue;
        push(part.segment);
      }

      // Unigrams make a single character (飯) match inside a longer word (白飯).
      // Bigrams are the fallback for runs the segmenter does not split well.
      const chars = Array.from(cjk);
      for (const c of chars) {
        if (!STOPWORDS.has(c)) push(c);
      }
      for (let i = 0; i + 1 < chars.length; i++) {
        const a = chars[i];
        const b = chars[i + 1];
        if (a === undefined || b === undefined) continue;
        if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
        push(a + b);
      }
      continue;
    }
    const latin = match[2];
    if (latin !== undefined && latin.length >= 2 && !ENGLISH_STOPWORDS.has(latin)) push(latin);
  }

  return out;
}

/**
 * The searchable part of a message: its tokens with particles removed, joined
 * so the index can take it as a plain query. Empty when nothing is left.
 */
export function keywordQuery(text: string): string {
  return tokenize(text).join(" ");
}
