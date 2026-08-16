import type { Capability } from "../../access/capability.js";
import type { ProviderClient } from "../../provider/provider-client.js";
import type { NativeToolRunner } from "../tool-broker.js";
import type { ToolResult } from "../tool-types.js";
import { OutboundWorkerClient } from "./outbound-worker-client.js";
import type { OutboundWorkerClientConfig } from "./outbound-worker-client.js";
import { WebArtifactStore } from "./web-artifact-store.js";
import type { WebArtifactStoreConfig } from "./web-artifact-store.js";
import { WebSummaryRunner } from "./web-summary-runner.js";
import type { SummarySource, WebSummaryConfig } from "./web-summary-runner.js";

export interface WebToolsConfig {
  worker: OutboundWorkerClientConfig;
  artifacts: WebArtifactStoreConfig;
  initialExtractChars: number;
  search: {
    maxResults: number;
    sourceCount: number;
    passageBudgetChars: number;
    summary: WebSummaryConfig;
  };
}

export interface WebToolsDeps {
  capability: Capability;
  config: WebToolsConfig;
  client?: Pick<OutboundWorkerClient, "fetchContent" | "search">;
  store?: WebArtifactStore;
  provider?: ProviderClient;
  summaryPrompt?: string;
  screen?: (text: string) => string;
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
  const screen = deps.screen ?? ((text: string) => text);

  const searchTool: NativeToolRunner = {
    definition: {
      name: "web_search",
      description:
        "Search the current web. Use grounded mode for a concise cited synthesis, or quick mode for snippet-only results.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          mode: { type: "string", enum: ["quick", "grounded"] },
          result_count: { type: "integer", minimum: 1, maximum: deps.config.search.maxResults },
          recency: { type: "string", enum: ["day", "week", "month", "year"] },
          include_domains: { type: "array", maxItems: 10, items: { type: "string" } },
          exclude_domains: { type: "array", maxItems: 10, items: { type: "string" } },
        },
      },
      category: "foreground",
      tier: "read",
      productGroup: "web",
      defaultExposure: "standard",
    },
    validate(args) {
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500)
        return validation("query must contain 1 to 500 characters");
      if (args.mode !== undefined && args.mode !== "quick" && args.mode !== "grounded")
        return validation("mode must be quick or grounded");
      const count = args.result_count ?? deps.config.search.maxResults;
      if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > deps.config.search.maxResults)
        return validation(`result_count must be between 1 and ${deps.config.search.maxResults}`);
      const domainRe =
        /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;
      for (const key of ["include_domains", "exclude_domains"] as const) {
        const domains = args[key] ?? [];
        if (
          !Array.isArray(domains) ||
          domains.length > 10 ||
          domains.some((d) => typeof d !== "string" || !domainRe.test(d))
        )
          return validation(`${key} must contain at most 10 valid domain names`);
      }
      const includes = (args.include_domains as string[] | undefined) ?? [];
      const excludes = (args.exclude_domains as string[] | undefined) ?? [];
      if (includes.some((d) => excludes.includes(d)))
        return validation("a domain cannot be both included and excluded");
      return null;
    },
    async run(args, { signal }) {
      const query = (args.query as string).trim();
      const mode = (args.mode as "quick" | "grounded" | undefined) ?? "grounded";
      const searched = await client.search(
        {
          query,
          count: (args.result_count as number | undefined) ?? deps.config.search.maxResults,
          ...(args.recency ? { recency: args.recency as "day" | "week" | "month" | "year" } : {}),
          includeDomains: ((args.include_domains as string[] | undefined) ?? []).map((d) => d.toLowerCase()),
          excludeDomains: ((args.exclude_domains as string[] | undefined) ?? []).map((d) => d.toLowerCase()),
        },
        signal,
      );
      if (!searched.ok) return result({ error: searched.error.code, message: searched.error.message }, true);
      const selected = searched.value.slice(0, deps.config.search.sourceCount);
      const statuses: Array<{ id: number; title: string; url: string; status: string; artifact_id?: string }> = [];
      const summarySources: SummarySource[] = [];
      if (mode === "grounded") {
        const fetched = await Promise.all(selected.map((source) => client.fetchContent(source.url, signal)));
        const perSource = Math.max(1, Math.floor(deps.config.search.passageBudgetChars / Math.max(1, selected.length)));
        for (const [i, got] of fetched.entries()) {
          const source = selected[i];
          if (!source) continue;
          if (got.ok) {
            const artifactId = await store.put(deps.capability, {
              sourceUrl: got.value.sourceUrl,
              finalUrl: got.value.finalUrl,
              title: got.value.title,
              contentType: got.value.contentType,
              content: got.value.content,
            });
            statuses.push({
              id: i + 1,
              title: source.title,
              url: source.url,
              status: "fetched",
              artifact_id: artifactId,
            });
            summarySources.push({
              id: i + 1,
              title: screen(source.title),
              url: source.url,
              passage: screen(got.value.content.slice(0, perSource)),
            });
          } else {
            statuses.push({ id: i + 1, title: source.title, url: source.url, status: got.error.code });
            summarySources.push({
              id: i + 1,
              title: screen(source.title),
              url: source.url,
              passage: screen(source.snippet.slice(0, perSource)),
            });
          }
        }
      } else {
        for (const [i, source] of selected.entries()) {
          statuses.push({ id: i + 1, title: source.title, url: source.url, status: "snippet" });
          summarySources.push({
            id: i + 1,
            title: screen(source.title),
            url: source.url,
            passage: screen(source.snippet),
          });
        }
      }
      if (signal.aborted) return result({ error: "cancelled", message: "Search was cancelled." }, true);
      const runner =
        deps.provider && deps.summaryPrompt
          ? new WebSummaryRunner({
              provider: deps.provider,
              config: deps.config.search.summary,
              prompt: deps.summaryPrompt,
              screen,
            })
          : null;
      const synthesized =
        mode === "grounded" && runner && summarySources.length > 0
          ? await runner.run(query, summarySources, signal)
          : {
              answer: (summarySources.length > 0
                ? summarySources.map((s) => `[${s.id}] ${s.title}: ${s.passage}`).join("\n")
                : "No web results were found for this query."
              ).slice(0, deps.config.search.summary.maxAnswerChars),
              citations: summarySources.map((s) => s.id),
              mode: "deterministic" as const,
            };
      if (signal.aborted) return result({ error: "cancelled", message: "Search was cancelled." }, true);
      return result({
        research_id: `wr_${crypto.randomUUID().replaceAll("-", "")}`,
        answer: screen(synthesized.answer).slice(0, deps.config.search.summary.maxAnswerChars),
        citations: synthesized.citations.map((id) => ({
          id,
          title: statuses[id - 1]?.title,
          url: statuses[id - 1]?.url,
        })),
        sources: statuses,
        synthesis: synthesized.mode,
      });
    },
  };

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
  return [searchTool, fetchTool, readTool];
}
