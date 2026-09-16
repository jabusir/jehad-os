import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  findPrincipalByCredentialHash,
  sha256Hex,
  type Principal,
  type SqlExecutor,
} from "@jehad/db";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AuthOptions {
  db: SqlExecutor;
  /** Paths exempt from authentication (liveness only — never authority). */
  publicPaths?: readonly string[];
}

export function extractBearerCredential(
  authorization: string | undefined,
): string | null {
  if (typeof authorization !== "string") return null;
  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

function deny(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header("www-authenticate", "Bearer")
    .send({ error: "unauthenticated" });
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function setupAuth(app: FastifyInstance, opts: AuthOptions): void {
  const publicPaths = new Set(opts.publicPaths ?? []);
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    if (publicPaths.has(request.url.split("?")[0] ?? "")) return;
    const credential = extractBearerCredential(request.headers.authorization);
    if (credential === null) {
      return deny(reply);
    }
    const presentedHash = sha256Hex(credential);
    const record = await findPrincipalByCredentialHash(opts.db, presentedHash);
    if (record === null || record.credentialHash === null) {
      return deny(reply);
    }
    // Constant-time defense-in-depth: the exact-match lookup should imply
    // equality, but timingSafeEqual guards the final decision against
    // collation/truncation surprises in the index comparison (T11).
    if (!hashesMatch(presentedHash, record.credentialHash)) {
      return deny(reply);
    }
    request.principal = {
      id: record.id,
      type: record.type,
      name: record.name,
    };
  });
}
