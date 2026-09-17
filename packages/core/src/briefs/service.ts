// Brief/close service entry points (plan §13 Brief + Close bullets): collect
// structured data, suppress when nothing meaningful changed (§31 — no
// artifact), otherwise render deterministic text and persist the artifact
// row (postgres backend, personal domain). The scheduled workflows
// (packages/workflow/src/brief-workflows.ts) and `josctl brief` both call
// these — one code path, no LLM anywhere.

import type { QueryExecutor } from "../queries/executor.js";
import {
  collectEveningCloseData,
  collectMorningBriefData,
  isEveningCloseMeaningful,
  isMorningBriefMeaningful,
  type BriefOptions,
} from "./data.js";
import { renderEveningCloseText, renderMorningBriefText } from "./render.js";
import { persistBriefArtifact } from "./artifacts.js";

export interface BriefOutcome {
  readonly kind: "brief" | "close";
  /** True when nothing meaningful changed — no content, no artifact row. */
  readonly suppressed: boolean;
  readonly content: string | null;
  readonly artifactId: string | null;
}

const SUPPRESSED_BRIEF: BriefOutcome = { kind: "brief", suppressed: true, content: null, artifactId: null };
const SUPPRESSED_CLOSE: BriefOutcome = { kind: "close", suppressed: true, content: null, artifactId: null };

export async function renderMorningBrief(
  db: QueryExecutor,
  opts: BriefOptions = {},
): Promise<BriefOutcome> {
  const data = await collectMorningBriefData(db, opts);
  if (!isMorningBriefMeaningful(data)) return SUPPRESSED_BRIEF;
  const content = renderMorningBriefText(data);
  const artifactId = await persistBriefArtifact(db, {
    kind: "brief",
    content,
    workflowId: "brief-morning",
    domainId: data.domainId,
    now: new Date(data.now),
  });
  return { kind: "brief", suppressed: false, content, artifactId };
}

export async function renderEveningClose(
  db: QueryExecutor,
  opts: BriefOptions = {},
): Promise<BriefOutcome> {
  const data = await collectEveningCloseData(db, opts);
  if (!isEveningCloseMeaningful(data)) return SUPPRESSED_CLOSE;
  const content = renderEveningCloseText(data);
  const artifactId = await persistBriefArtifact(db, {
    kind: "close",
    content,
    workflowId: "brief-evening",
    domainId: data.domainId,
    now: new Date(data.now),
  });
  return { kind: "close", suppressed: false, content, artifactId };
}
