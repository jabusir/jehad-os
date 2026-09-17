/**
 * HTTP client for POST /events. Transport only: building the occurrence is
 * commands.ts's job (via the cli capture SourceAdapter), auth comes from the
 * Keychain reader.
 */

export interface IngestSuccess {
  ok: true;
  status: 200 | 201;
  duplicate: boolean;
  id: string;
  type: string;
}

export interface IngestFailure {
  ok: false;
  status: number;
  code?: string;
  message?: string;
}

export type IngestResult = IngestSuccess | IngestFailure;

export interface IngestBody {
  readonly type: string;
  readonly source: string;
  readonly externalId: string;
  readonly occurredAt: string;
  readonly domainId: string;
  readonly sensitivity: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly schemaVersion: number;
}

export type FetchLike = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

export async function postEvent(
  baseUrl: string,
  credential: string,
  body: IngestBody,
  fetchImpl: FetchLike,
): Promise<IngestResult> {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  if (
    (response.status === 200 || response.status === 201) &&
    typeof json === "object" &&
    json !== null
  ) {
    const parsed = json as { duplicate?: unknown; event?: { id?: unknown; type?: unknown } };
    if (typeof parsed.event?.id === "string" && typeof parsed.event.type === "string") {
      return {
        ok: true as const,
        status: response.status as 200 | 201,
        duplicate: parsed.duplicate === true,
        id: parsed.event.id,
        type: parsed.event.type,
      };
    }
  }
  const failure = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  return {
    ok: false as const,
    status: response.status,
    code: typeof failure.code === "string" ? failure.code : undefined,
    message: typeof failure.message === "string" ? failure.message : undefined,
  };
}
