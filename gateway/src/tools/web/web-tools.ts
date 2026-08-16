import type { Capability } from "../../access/capability.js";
import type { NativeToolRunner } from "../tool-broker.js";
import type { ToolResult } from "../tool-types.js";
import { OutboundWorkerClient } from "./outbound-worker-client.js";
import type { OutboundWorkerClientConfig } from "./outbound-worker-client.js";
import { WebArtifactStore } from "./web-artifact-store.js";
import type { WebArtifactStoreConfig } from "./web-artifact-store.js";

export interface WebToolsConfig {
  worker: OutboundWorkerClientConfig;
  artifacts: WebArtifactStoreConfig;
  initialExtractChars: number;
}

export interface WebToolsDeps {
  capability: Capability;
  config: WebToolsConfig;
  client?: Pick<OutboundWorkerClient, "fetchContent">;
  store?: WebArtifactStore;
}

function result(value: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(value), isError };
}

function validation(message: string): ToolResult {
  return result({ error: "invalid_request", message }, true);
}

function continuation(id: string, end: number, total: number): string | null {
  return end < total ? `Call read_web_content with artifact_id "${id}", offset ${end}, and a bounded limit.` : null;
}

export function createWebTools(deps: WebToolsDeps): readonly NativeToolRunner[] {
  if (deps.capability.resource !== "web-artifact") throw new Error("web artifact capability required");
  const client = deps.client ?? new OutboundWorkerClient(deps.config.worker);
  const store = deps.store ?? new WebArtifactStore(deps.config.artifacts);

  const fetchTool: NativeToolRunner = {
    definition: {
      name: "fetch_content",
      description:
        "Fetch an HTTP/HTTPS page safely and return a bounded readable extract. The complete extraction is stored outside the conversation for read_web_content.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: { url: { type: "string", description: "HTTP or HTTPS URL to retrieve." } },
      },
      category: "foreground",
      tier: "read",
      productGroup: "web",
      defaultExposure: "standard",
    },
    validate(args) {
      if (typeof args.url !== "string" || args.url.length < 1 || args.url.length > 4096)
        return validation("url must be a non-empty string no longer than 4096 characters");
      return null;
    },
    async run(args, { signal }) {
      const fetched = await client.fetchContent(args.url as string, signal);
      if (!fetched.ok)
        return result(
          { error: fetched.error.code, message: fetched.error.message, hostname: fetched.error.hostname },
          true,
        );
      const artifactId = await store.put(deps.capability, {
        sourceUrl: fetched.value.sourceUrl,
        finalUrl: fetched.value.finalUrl,
        title: fetched.value.title,
        contentType: fetched.value.contentType,
        content: fetched.value.content,
      });
      const end = Math.min(deps.config.initialExtractChars, fetched.value.content.length);
      return result({
        artifact_id: artifactId,
        source: {
          requested_url: fetched.value.sourceUrl,
          final_url: fetched.value.finalUrl,
          title: fetched.value.title,
          byline: fetched.value.byline,
          content_type: fetched.value.contentType,
        },
        total_chars: fetched.value.content.length,
        returned_range: { start: 0, end },
        content: fetched.value.content.slice(0, end),
        continuation: continuation(artifactId, end, fetched.value.content.length),
      });
    },
  };

  const readTool: NativeToolRunner = {
    definition: {
      name: "read_web_content",
      description: "Read a bounded slice or matching passages from a web artifact owned by the current user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["artifact_id"],
        properties: {
          artifact_id: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: deps.config.artifacts.maxSliceChars },
          passage: { type: "string", minLength: 2, maxLength: 200 },
          max_passages: { type: "integer", minimum: 1, maximum: deps.config.artifacts.maxPassages },
        },
      },
      category: "foreground",
      tier: "read",
      productGroup: "web",
      defaultExposure: "standard",
    },
    validate(args) {
      if (typeof args.artifact_id !== "string") return validation("artifact_id is required");
      const hasPassage = args.passage !== undefined;
      const hasSlice = args.offset !== undefined || args.limit !== undefined;
      if (hasPassage && hasSlice) return validation("choose passage matching or offset/limit, not both");
      if (
        hasPassage &&
        (typeof args.passage !== "string" || args.passage.trim().length < 2 || args.passage.length > 200)
      )
        return validation("passage must contain 2 to 200 characters");
      if (!hasPassage) {
        const offset = args.offset ?? 0;
        const limit = args.limit ?? deps.config.initialExtractChars;
        if (!Number.isInteger(offset) || (offset as number) < 0)
          return validation("offset must be a non-negative integer");
        if (
          !Number.isInteger(limit) ||
          (limit as number) < 1 ||
          (limit as number) > deps.config.artifacts.maxSliceChars
        )
          return validation(`limit must be between 1 and ${deps.config.artifacts.maxSliceChars}`);
      }
      return null;
    },
    async run(args) {
      const id = args.artifact_id as string;
      const read =
        typeof args.passage === "string"
          ? await store.findPassages(deps.capability, id, args.passage, (args.max_passages as number | undefined) ?? 3)
          : await store.readSlice(
              deps.capability,
              id,
              (args.offset as number | undefined) ?? 0,
              (args.limit as number | undefined) ?? deps.config.initialExtractChars,
            );
      if (!read.ok)
        return result(
          {
            error: read.error,
            message: "The web artifact or requested bounded read is unavailable for this user.",
          },
          true,
        );
      return result({
        artifact_id: read.value.id,
        source: {
          requested_url: read.value.sourceUrl,
          final_url: read.value.finalUrl,
          title: read.value.title,
          content_type: read.value.contentType,
        },
        total_chars: read.value.totalChars,
        returned_range: { start: read.value.returnedStart, end: read.value.returnedEnd },
        ...(read.value.matches === undefined ? {} : { matches: read.value.matches }),
        content: read.value.content,
        continuation: continuation(read.value.id, read.value.returnedEnd, read.value.totalChars),
      });
    },
  };
  return [fetchTool, readTool];
}
