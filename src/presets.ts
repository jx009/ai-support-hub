import { randomInt } from "node:crypto";
import type { Settings } from "./model.js";

export function sampleQuestions(questions: Settings["questions"]) {
  const seen = new Set<string>();
  const pool = questions.filter((q) => {
    const text = q.question.trim();
    if (!q.enabled || !text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
  const count = Math.min(3, pool.length);
  for (let i = 0; i < count; i++) {
    const j = randomInt(i, pool.length);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}
