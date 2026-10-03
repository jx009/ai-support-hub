import { expect, it, vi, beforeEach } from "vitest";
import { randomInt } from "node:crypto";
import { sampleQuestions } from "../src/presets.js";
vi.mock("node:crypto", () => ({ randomInt: vi.fn() }));
const questions = Array.from({ length: 8 }, (_, i) => ({ id: String(i), question: `问题 ${i}`, enabled: true }));
beforeEach(() => vi.mocked(randomInt).mockReset().mockImplementation(((min: number, max: number) => max - 1) as any));

it("samples three distinct questions without changing the configured pool", () => {
  const before = structuredClone(questions);
  const selected = sampleQuestions(questions);
  expect(selected).toHaveLength(3);
  expect(new Set(selected.map((q) => q.id)).size).toBe(3);
  expect(questions).toEqual(before);
});
it("selects again on each initialization instead of always using the first three", () => {
  vi.mocked(randomInt).mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(2);
  const first = sampleQuestions(questions);
  expect(sampleQuestions(questions)).not.toEqual(first);
});
it("excludes disabled and duplicate questions", () => {
  const selected = sampleQuestions([
    ...questions.slice(0, 2),
    { id: "duplicate", question: " 问题 0 ", enabled: true },
    { id: "disabled", question: "禁用的问题", enabled: false },
  ]);
  expect(selected).toHaveLength(2);
  expect(selected.map((q) => q.id).sort()).toEqual(["0", "1"]);
});
it("allows fewer than three questions and an empty pool", () => {
  expect(sampleQuestions(questions.slice(0, 1))).toEqual(questions.slice(0, 1));
  expect(sampleQuestions([])).toEqual([]);
});
