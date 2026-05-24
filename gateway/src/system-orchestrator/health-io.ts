import { spawn } from "node:child_process";
import { connect } from "node:net";
import type { HealthIO } from "./health.js";

export const defaultHealthIO: HealthIO = {
  fetch: async (url: string, timeoutMs: number): Promise<{ ok: boolean }> => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await globalThis.fetch(url, { signal: ctl.signal });
      return { ok: r.ok };
    } finally {
      clearTimeout(t);
    }
  },

  tcpProbe: (target: string, timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const [host, portStr] = target.split(":");
      const sock = connect({ host: host ?? "", port: Number(portStr ?? "0") });
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(false);
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    }),

  execProbe: (cmd: string[], timeoutMs: number): Promise<number> =>
    new Promise<number>((resolve) => {
      const [bin, ...args] = cmd;
      if (!bin) {
        resolve(-1);
        return;
      }
      const child = spawn(bin, args);
      const timer = setTimeout(() => {
        child.kill();
        resolve(-1);
      }, timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(-1);
      });
    }),

  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),

  now: (): number => Date.now(),
};
