const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "is",
  "are",
  "was",
  "were",
  "for",
  "with",
  "on",
  "at",
  "from",
  "by",
  "what",
  "why",
  "how",
  "can",
  "could",
  "i",
  "my",
  "me",
  "you",
  "your",
  "it",
  "this",
  "that",
  "have",
  "has",
  "do",
  "does",
  "about",
  "please",
  "tell",
  "explain",
]);

export function tokenize(value = "") {
  return (
    value
      .toLowerCase()
      .normalize("NFKC")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length > 2 && !STOP_WORDS.has(token)) || []
  );
}

export class LexicalIndex {
  constructor(records = [], getText = (record) => record.text || "") {
    this.records = records;
    this.getText = getText;
    this.documents = records.map((record) => {
      const tokens = tokenize(getText(record));
      const frequencies = new Map();
      for (const token of tokens)
        frequencies.set(token, (frequencies.get(token) || 0) + 1);
      return { record, tokens, frequencies };
    });
    this.averageLength =
      this.documents.reduce((sum, item) => sum + item.tokens.length, 0) /
      (this.documents.length || 1);
    this.documentFrequency = new Map();
    for (const document of this.documents) {
      for (const token of new Set(document.tokens)) {
        this.documentFrequency.set(
          token,
          (this.documentFrequency.get(token) || 0) + 1,
        );
      }
    }
  }

  search(query, count = 6) {
    const queryTokens = [...new Set(tokenize(query))];
    if (!queryTokens.length || !this.documents.length) return [];
    const total = this.documents.length;
    const k1 = 1.5;
    const b = 0.75;
    const scored = this.documents.map((document) => {
      let score = 0;
      for (const token of queryTokens) {
        const frequency = document.frequencies.get(token) || 0;
        if (!frequency) continue;
        const containing = this.documentFrequency.get(token) || 0;
        const inverseFrequency = Math.log(
          1 + (total - containing + 0.5) / (containing + 0.5),
        );
        const lengthFactor =
          frequency +
          k1 *
            (1 - b + (b * document.tokens.length) / (this.averageLength || 1));
        score += (inverseFrequency * (frequency * (k1 + 1))) / lengthFactor;
      }
      return { ...document.record, score: Number(score.toFixed(4)) };
    });

    return scored
      .filter((item) => item.score > 0)
      .sort((a, bValue) => bValue.score - a.score)
      .slice(0, count);
  }
}

export function normalizeScores(results) {
  const maximum = results[0]?.score || 1;
  return results.map((result) => ({
    ...result,
    score: Number((result.score / maximum).toFixed(3)),
  }));
}
