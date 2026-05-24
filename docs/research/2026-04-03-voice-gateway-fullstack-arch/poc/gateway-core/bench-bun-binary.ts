const PORT = 9103;
const OPUS_FRAME = Buffer.alloc(320, 0xAB);
let frameCount = 0;
let startTime = 0;
const DURATION_MS = 5000;

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    message(ws, data) {
      frameCount++;
      ws.send(data);
    },
    open(ws) {},
    close(ws) {},
  },
});

console.log(`Bun binary relay server on ${PORT}`);

const clients: WebSocket[] = [];
let connected = 0;

for (let i = 0; i < 5; i++) {
  const c = new WebSocket(`ws://localhost:${PORT}`);
  c.binaryType = "arraybuffer";
  clients.push(c);
  c.addEventListener("open", () => {
    connected++;
    if (connected === 5) startBench();
  });
}

function startBench() {
  startTime = Date.now();
  frameCount = 0;

  for (const c of clients) {
    c.addEventListener("message", () => {
      if (Date.now() - startTime < DURATION_MS) {
        c.send(OPUS_FRAME);
      }
    });
    c.send(OPUS_FRAME);
  }

  setTimeout(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const mem = process.memoryUsage();
    console.log(`\n--- Bun Binary Relay Results ---`);
    console.log(`5 sessions, ${elapsed.toFixed(1)}s`);
    console.log(`Total frames relayed: ${frameCount}`);
    console.log(`Frames/sec: ${(frameCount / elapsed).toFixed(0)}`);
    console.log(`Frames/sec/session: ${(frameCount / elapsed / 5).toFixed(0)}`);
    console.log(`RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB`);
    console.log(`(Need ~50 frames/sec/session for real-time Opus @ 20ms)`);
    clients.forEach(c => c.close());
    server.stop();
    process.exit(0);
  }, DURATION_MS + 500);
}
