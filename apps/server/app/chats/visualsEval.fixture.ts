/**
 * Questions over documents with known figures, for the retrieval eval (M7) to run against a real model. Each case says
 * which fact source the design expects (spec C1): `stored` (the document is short enough for the summary cap, so
 * sub-project 1 stored its facts) or `fallback` (the figure sits past the cap, or the document yields no stored fact).
 * The eval measures how often each source is used and how many facts are wrong (a fact whose figure is not in `figures`).
 * Run the eval deployment with `DOCMIND_SUMMARY_MAX_CHARS=EVAL_SUMMARY_MAX_CHARS`: the cases are sized against that cap,
 * not against the 400000 default (ruling P5).
 */
export const EVAL_SUMMARY_MAX_CHARS = 20_000;
export interface VisualsEvalCase {
  id: string;
  /** The document text the model is shown. */
  document: string;
  question: string;
  /** The figures the document states and a correct fact may carry. */
  figures: { label: string; value: number }[];
  expectedSource: "stored" | "fallback";
}

/** About 55 characters per repeat, and no digit: the first digit of a case is its first figure. 1000 repeats are about 55,000 characters, well past `EVAL_SUMMARY_MAX_CHARS`. */
const filler = (n: number) => "The committee reviewed the agenda and noted the minutes. ".repeat(n);

export const VISUALS_EVAL_CASES: VisualsEvalCase[] = [
  {
    id: "revenue-year",
    document: "Revenue was 1,200 in 2023 and 1,500 in 2024.",
    question: "How did revenue change?",
    figures: [
      { label: "Revenue 2023", value: 1200 },
      { label: "Revenue 2024", value: 1500 },
    ],
    expectedSource: "stored",
  },
  {
    id: "headcount",
    document: "Headcount reached 300 at year end, up from 240.",
    question: "How many people work there now?",
    figures: [
      { label: "Headcount", value: 300 },
      { label: "Previous headcount", value: 240 },
    ],
    expectedSource: "stored",
  },
  {
    id: "margin-percent",
    document: "The gross margin was 42% and the net margin 12%.",
    question: "What are the margins?",
    figures: [
      { label: "Gross margin", value: 42 },
      { label: "Net margin", value: 12 },
    ],
    expectedSource: "stored",
  },
  {
    id: "invoice-terms",
    document: "Invoices are due within 30 days. Late payment accrues 2% interest per month.",
    question: "When are invoices due and what does late payment cost?",
    figures: [
      { label: "Days to pay", value: 30 },
      { label: "Monthly interest", value: 2 },
    ],
    expectedSource: "stored",
  },
  {
    id: "quarterly-table",
    document: "Q1 sales 410. Q2 sales 455. Q3 sales 498. Q4 sales 530.",
    question: "Show sales by quarter.",
    figures: [
      { label: "Q1", value: 410 },
      { label: "Q2", value: 455 },
      { label: "Q3", value: 498 },
      { label: "Q4", value: 530 },
    ],
    expectedSource: "stored",
  },
  {
    id: "late-figure",
    document: `${filler(1000)} In the final appendix, total reserves stood at 7,391.25.`,
    question: "What were the total reserves?",
    figures: [{ label: "Total reserves", value: 7391.25 }],
    expectedSource: "fallback",
  },
  {
    id: "late-series",
    document: `${filler(1000)} Reserves by year: 2022 5,100; 2023 6,250; 2024 7,391.`,
    question: "How did reserves develop?",
    figures: [
      { label: "2022", value: 5100 },
      { label: "2023", value: 6250 },
      { label: "2024", value: 7391 },
    ],
    expectedSource: "fallback",
  },
  {
    id: "late-currency",
    document: `${filler(1000)} The settlement was $2.4M, paid in two instalments.`,
    question: "How large was the settlement?",
    figures: [{ label: "Settlement", value: 2_400_000 }],
    expectedSource: "fallback",
  },
];

export interface VisualsEvalResult {
  id: string;
  source: "stored" | "fallback" | "none";
  facts: { label: string; value: number }[];
}

/** How many questions used each source, and how many facts carry a figure the case does not know. */
export function summarizeVisualsEval(results: readonly VisualsEvalResult[]): {
  stored: number;
  fallback: number;
  none: number;
  wrongFacts: number;
} {
  const known = new Map(
    VISUALS_EVAL_CASES.map((c) => [c.id, new Set(c.figures.map((f) => f.value))]),
  );
  const out = { stored: 0, fallback: 0, none: 0, wrongFacts: 0 };
  for (const r of results) {
    out[r.source]++;
    out.wrongFacts += r.facts.filter((f) => !known.get(r.id)?.has(f.value)).length;
  }
  return out;
}
