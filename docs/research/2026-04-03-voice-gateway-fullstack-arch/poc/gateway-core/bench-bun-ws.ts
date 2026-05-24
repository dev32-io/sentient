const PORT = 9101;
let msgCount = 0;
let startTime = 0;
const DURATION_MS = 5000;
const msg = JSON.stringify({ type: "text.input", text: "hello world", ts: Date.now() });

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    message(ws, data) {
      msgCount++;
      ws.send(data);
    },
    open(ws) {},
    close(ws) {},
  },
});

console.log(`Bun WS server on ${PORT}`);
console.log(`RSS before clients: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB`);

// Connect 10 clients
const clients: WebSocket[] = [];
let connected = 0;

for (let i = 0; i < 10; i++) {
  const c = new WebSocket(`ws://localhost:${PORT}`);
  clients.push(c);
  c.addEventListener("open", () => {
    connected++;
    if (connected === 10) startBenchmark();
  });
}

function startBenchmark() {
  console.log(`RSS with 10 clients: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}MB`);
  startTime = Date.now();
  msgCount = 0;

  for (const c of clients) {
    c.addEventListener("message", () => {
      if (Date.now() - startTime < DURATION_MS) {
        c.send(msg);
      }
    });
    c.send(msg);
  }

  setTimeout(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const memFinal = process.memoryUsage();
    console.log(`\n--- Bun WS Results ---`);
    console.log(`Duration: ${elapsed.toFixed(1)}s`);
    console.log(`Total echoes: ${msgCount}`);
    console.log(`Msgs/sec: ${(msgCount / elapsed).toFixed(0)}`);
    console.log(`Final RSS: ${(memFinal.rss / 1024 / 1024).toFixed(1)}MB`);

    clients.forEach(c => c.close());
    server.stop();
    process.exit(0);
  }, DURATION_MS + 500);
}
