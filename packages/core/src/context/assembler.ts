import { estimateTokens } from "../imessage/threads.js";

export const DEFAULT_PASS_TOKEN_BUDGET = 6000;
export const DEFAULT_PER_BLOCK_TOKEN_BUDGET = 1500;
export const BLOCK_TRUNCATION_MARKER = "…[truncated]";

export interface AssemblerDataBlock {
  readonly source: string;
  readonly provenance: string;
  readonly content: string;
}

export interface AssemblePassContextInput {
  readonly personaFragment?: string | null;
  readonly historyBlock?: readonly string[] | null;
  readonly dataBlocks?: readonly AssemblerDataBlock[] | null;
  readonly caveats?: readonly string[] | null;
  readonly tokenBudget?: number | null;
  readonly perBlockTokenBudget?: number | null;
}

export type AssembledSectionKind = "persona" | "history" | "data" | "caveats";

export interface AssembledSection {
  readonly kind: AssembledSectionKind;
  readonly label: string;
  readonly lines: readonly string[];
  readonly tokenEstimate: number;
  readonly truncated: boolean;
}

export interface AssembledContext {
  readonly sections: readonly AssembledSection[];
  readonly lines: readonly string[];
  readonly tokenEstimate: number;
  readonly truncated: boolean;
}

export function flattenUntrusted(text: string): string {
  return text.replace(/\r?\n/g, "\\n");
}

function truncateToTokenBudget(
  text: string,
  tokenBudget: number,
): { readonly text: string; readonly truncated: boolean } {
  const maxChars = Math.max(0, tokenBudget) * 4;
  if (text.length <= maxChars) return { text, truncated: false };
  const keep = Math.max(0, maxChars - BLOCK_TRUNCATION_MARKER.length);
  return { text: text.slice(0, keep) + BLOCK_TRUNCATION_MARKER, truncated: true };
}

function sectionOf(
  kind: AssembledSectionKind,
  label: string,
  lines: readonly string[],
  truncated = false,
): AssembledSection {
  return { kind, label, lines, tokenEstimate: estimateTokens(lines.join("\n")), truncated };
}

export function assemblePassContext(input: AssemblePassContextInput): AssembledContext {
  const passBudget = input.tokenBudget ?? DEFAULT_PASS_TOKEN_BUDGET;
  const blockBudget = input.perBlockTokenBudget ?? DEFAULT_PER_BLOCK_TOKEN_BUDGET;
  const units: AssembledSection[] = [];

  const persona =
    typeof input.personaFragment === "string" ? input.personaFragment.trim() : "";
  if (persona.length > 0) {
    units.push(sectionOf("persona", "persona", [flattenUntrusted(persona)]));
  }

  if (input.historyBlock !== null && input.historyBlock !== undefined && input.historyBlock.length > 0) {
    units.push(sectionOf("history", "history", [...input.historyBlock]));
  }

  if (input.dataBlocks !== null && input.dataBlocks !== undefined) {
    for (const block of input.dataBlocks) {
      const source = block.source.trim();
      if (source.length === 0) continue;
      const provenance = block.provenance.trim();
      const content = block.content.trim();
      if (provenance.length === 0 && content.length === 0) continue;
      const label = flattenUntrusted(provenance.length > 0 ? `${source} — ${provenance}` : source);
      const capped = truncateToTokenBudget(flattenUntrusted(content), blockBudget);
      units.push(sectionOf("data", source, [`[source: ${label}]`, capped.text], capped.truncated));
    }
  }

  const caveats =
    input.caveats !== null && input.caveats !== undefined
      ? input.caveats.filter((c) => typeof c === "string" && c.trim().length > 0)
      : [];
  if (caveats.length > 0) {
    units.push(
      sectionOf("caveats", "caveats", caveats.map((c) => `CAVEAT: ${flattenUntrusted(c.trim())}`)),
    );
  }

  const sections: AssembledSection[] = [];
  let tokens = 0;
  let dropped = 0;
  for (const unit of units) {
    if (tokens + unit.tokenEstimate > passBudget) {
      dropped += 1;
      continue;
    }
    tokens += unit.tokenEstimate;
    sections.push(unit);
  }

  const lines: string[] = [];
  for (const section of sections) lines.push(...section.lines);
  if (dropped > 0) {
    lines.push(
      `(${dropped} context block${dropped === 1 ? "" : "s"} left out to stay within the token budget.)`,
    );
  }
  return {
    sections,
    lines,
    tokenEstimate: tokens,
    truncated: dropped > 0 || sections.some((s) => s.truncated),
  };
}
