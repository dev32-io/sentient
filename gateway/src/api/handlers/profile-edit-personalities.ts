import { getLog } from "../../logging/logger.js";
import type { PersonalityStore, PersonalityStoreError } from "../../profile-store/personality-store.js";

const log = getLog(["sentient", "gateway", "api", "profile-edit", "personalities"]);

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD = 405;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL = 500;

export interface PersonalityHandlerDeps {
  buildPersonalityStore: (userId: string) => PersonalityStore;
}

export async function listPersonalities(deps: PersonalityHandlerDeps, userId: string): Promise<Response> {
  log.info("list", { userId });
  const r = await deps.buildPersonalityStore(userId).list();
  if (!r.ok) return mapPersonalityError(r.error);
  return Response.json(r.value, { status: HTTP_OK });
}

export async function addPersonality(
  deps: PersonalityHandlerDeps,
  userId: string,
  payload: unknown,
): Promise<Response | Response> {
  const parsed = parseAddPayload(payload);
  if (!parsed.ok) return parsed.response;
  log.info("add", { userId, name: parsed.value.name });
  const r = await deps.buildPersonalityStore(userId).add(parsed.value.name, parsed.value.body);
  if (!r.ok) return mapPersonalityError(r.error);
  return new Response(null, { status: HTTP_NO_CONTENT });
}

export async function updatePersonality(
  deps: PersonalityHandlerDeps,
  userId: string,
  name: string,
  payload: unknown,
): Promise<Response> {
  const body = (payload as { body?: unknown }).body;
  if (typeof body !== "string") return jsonError(HTTP_UNPROCESSABLE, "schema-invalid");
  log.info("update", { userId, name });
  const r = await deps.buildPersonalityStore(userId).update(name, body);
  if (!r.ok) return mapPersonalityError(r.error);
  return new Response(null, { status: HTTP_NO_CONTENT });
}

export async function removePersonality(deps: PersonalityHandlerDeps, userId: string, name: string): Promise<Response> {
  log.info("remove", { userId, name });
  const r = await deps.buildPersonalityStore(userId).remove(name);
  if (!r.ok) return mapPersonalityError(r.error);
  return new Response(null, { status: HTTP_NO_CONTENT });
}

// Active-personality dispatch — formerly fired a `/personality <name>`
// internal user message at the per-user Hermes worker over the legacy
// custom-WS connection pool. ACP has no equivalent today; the personality
// edit still lands on disk via the personality-store, so the next fresh
// session picks it up. Accept the request and log a warning explaining
// the gap.
//
// TODO(acp-rewire): re-implement under ACP — see
// docs/research/2026-05-08-apply-restart-acp-rewire-todo.md.
export async function dispatchActivePersonality(
  _deps: PersonalityHandlerDeps,
  userId: string,
  payload: unknown,
): Promise<Response> {
  const name = (payload as { name?: unknown }).name;
  if (typeof name !== "string" || name.length === 0) return jsonError(HTTP_UNPROCESSABLE, "schema-invalid");
  log.warn("active.skipped-acp-no-equivalent", {
    userId,
    name,
    reason: "ACP wire has no /personality slash-command equivalent — see acp-rewire-todo.md",
  });
  return new Response(null, { status: HTTP_NO_CONTENT });
}

interface ParsedAddOk {
  ok: true;
  value: { name: string; body: string };
}
interface ParsedAddErr {
  ok: false;
  response: Response;
}

function parseAddPayload(payload: unknown): ParsedAddOk | ParsedAddErr {
  const obj = payload as { name?: unknown; body?: unknown };
  if (typeof obj.name !== "string" || typeof obj.body !== "string") {
    return { ok: false, response: jsonError(HTTP_UNPROCESSABLE, "schema-invalid") };
  }
  return { ok: true, value: { name: obj.name, body: obj.body } };
}

export function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: HTTP_METHOD });
}

export function notFound(): Response {
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}

export function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

export function mapPersonalityError(error: PersonalityStoreError): Response {
  switch (error) {
    case "io-error":
      return jsonError(HTTP_INTERNAL, "io-error");
    case "parse-error":
      return jsonError(HTTP_INTERNAL, "parse-error");
    case "name-conflict":
      return jsonError(HTTP_CONFLICT, "name-conflict");
    case "invalid-name":
      return jsonError(HTTP_UNPROCESSABLE, "invalid-name");
    case "not-found":
      return jsonError(HTTP_NOT_FOUND, "not-found");
    default:
      return jsonError(HTTP_INTERNAL, "unknown");
  }
}
