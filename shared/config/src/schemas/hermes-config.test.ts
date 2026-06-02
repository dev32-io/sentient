import { describe, expect, it } from "vitest";
import { hermesConfigSchema } from "./hermes-config";

describe("hermesConfigSchema", () => {
  it("accepts a minimal valid config with worker template", () => {
    const input = {
      worker: {
        container_name: "sentient-hermes",
        url_template: "http://sentient-hermes:{port}",
      },
    };
    const result = hermesConfigSchema.parse(input);
    expect(result.worker.container_name).toBe("sentient-hermes");
    expect(result.worker.url_template).toBe("http://sentient-hermes:{port}");
    expect(result.worker.port_base).toBe(8650);
    expect(result.defaults.max_output_tokens).toBe(512);
    expect(result.web_tools.provider).toBe("searxng");
    expect(result.home_assistant_observer.enabled).toBe(true);
    expect(result.ambient.dispatch.steward_enabled).toBe(false);
  });

  it("rejects url_template missing {port} placeholder", () => {
    const input = {
      worker: {
        container_name: "sentient-hermes",
        url_template: "http://sentient-hermes:8650",
      },
    };
    expect(() => hermesConfigSchema.parse(input)).toThrow(/\{port\}/);
  });

  it("rejects port_base below 1024", () => {
    const input = {
      worker: {
        container_name: "sentient-hermes",
        url_template: "http://sentient-hermes:{port}",
        port_base: 80,
      },
    };
    expect(() => hermesConfigSchema.parse(input)).toThrow();
  });

  it("accepts custom port_base", () => {
    const input = {
      worker: {
        container_name: "sentient-hermes",
        url_template: "http://sentient-hermes:{port}",
        port_base: 9000,
      },
    };
    const result = hermesConfigSchema.parse(input);
    expect(result.worker.port_base).toBe(9000);
  });

  it("fills defaults for optional sections", () => {
    const input = {
      worker: {
        container_name: "sentient-hermes",
        url_template: "http://sentient-hermes:{port}",
      },
    };
    const result = hermesConfigSchema.parse(input);
    expect(result.resource_management.mode).toBe("always_on");
    expect(result.resource_management.cold_start_filler_text).toBe("one sec...");
    expect(result.mcp_host.transport).toBe("unix_socket");
    expect(result.tts.markdown_stripping_enabled).toBe(true);
  });

  it("fills acp_wire reconnect defaults when omitted", () => {
    const input = {
      worker: {
        container_name: "sentient-hermes",
        url_template: "http://sentient-hermes:{port}",
      },
    };
    const result = hermesConfigSchema.parse(input);
    expect(result.acp_wire.open_timeout_ms).toBe(5000);
    expect(result.acp_wire.reconnect_base_ms).toBe(500);
    expect(result.acp_wire.reconnect_max_ms).toBe(5000);
    expect(result.acp_wire.reconnect_jitter_ms).toBe(250);
    expect(result.acp_wire.reconnect_max_attempts).toBe(5);
  });
});
