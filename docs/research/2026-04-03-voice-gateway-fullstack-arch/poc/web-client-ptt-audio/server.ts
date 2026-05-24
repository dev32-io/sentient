/**
 * PoC: Web Client PTT Audio Pipeline — Bun WebSocket Server
 * 
 * Serves static client with COOP/COEP headers, echoes binary audio,
 * parses WebM container from MediaRecorder chunks, tracks metrics.
 */

import { parseWebM, type WebMParseResult } from "./webm-parser.ts";

interface SessionMetrics {
  framesReceived: number;
  framesSent: number;
  bytesReceived: number;
  bytesSent: number;
  webmParseResult: WebMParseResult | null;
  allBinaryData: Buffer[];
  startTime: number;
}

function createMetrics(): SessionMetrics {
  return {
    framesReceived: 0,
    framesSent: 0,
    bytesReceived: 0,
    bytesSent: 0,
    webmParseResult: null,
    allBinaryData: [],
    startTime: Date.now(),
  };
}

const clientHTML = await Bun.file(new URL("./client.html", import.meta.url).pathname).text();
const workletJS = await Bun.file(new URL("./ring-buffer-worklet.js", import.meta.url).pathname).text();

const sessions = new Map<any, SessionMetrics>();

const COOP_COEP = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const server = Bun.serve({
  port: 3099,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      return server.upgrade(req) ? undefined : new Response("Upgrade failed", { status: 400 });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(clientHTML, { headers: { "Content-Type": "text/html", ...COOP_COEP } });
    }

    if (url.pathname === "/ring-buffer-worklet.js") {
      return new Response(workletJS, { headers: { "Content-Type": "application/javascript", ...COOP_COEP } });
    }

    if (url.pathname === "/health") {
      const allMetrics = [];
      for (const [, m] of sessions) {
        allMetrics.push({ ...m, allBinaryData: undefined, durationMs: Date.now() - m.startTime });
      }
      return new Response(JSON.stringify({ sessions: allMetrics }, null, 2), {
        headers: { "Content-Type": "application/json", ...COOP_COEP },
      });
    }

    if (url.pathname === "/coop-coep-test") {
      return new Response(JSON.stringify({ headers: COOP_COEP }), {
        headers: { "Content-Type": "application/json", ...COOP_COEP },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const m = createMetrics();
      sessions.set(ws, m);
      ws.send(JSON.stringify({ type: "session.ready" }));
    },

    message(ws, message) {
      const m = sessions.get(ws);
      if (!m) return;

      if (typeof message === "string") {
        try {
          const msg = JSON.parse(message);
          if (msg.type === "audio.end" || msg.type === "get_metrics") {
            // Parse accumulated WebM data
            if (m.allBinaryData.length > 0) {
              const combined = Buffer.concat(m.allBinaryData);
              m.webmParseResult = parseWebM(combined);
            }
            ws.send(JSON.stringify({
              type: "metrics",
              framesReceived: m.framesReceived,
              framesSent: m.framesSent,
              bytesReceived: m.bytesReceived,
              bytesSent: m.bytesSent,
              webmParser: m.webmParseResult ? {
                elementsFound: m.webmParseResult.elements.length,
                audioTrackFound: m.webmParseResult.audioTrackFound,
                codecId: m.webmParseResult.codecId,
                simpleBlocks: m.webmParseResult.simpleBlocks,
                totalAudioBytes: m.webmParseResult.totalAudioBytes,
                errors: m.webmParseResult.errors,
              } : null,
              durationMs: Date.now() - m.startTime,
            }));
          }
        } catch {}
      } else {
        const buf = Buffer.from(message);
        m.framesReceived++;
        m.bytesReceived += buf.length;
        m.allBinaryData.push(buf);

        // Echo back
        ws.send(buf);
        m.framesSent++;
        m.bytesSent += buf.length;
      }
    },

    close(ws) {
      sessions.delete(ws);
    },
  },
});

console.log(`Server running at http://localhost:${server.port}`);
