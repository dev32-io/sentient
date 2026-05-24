const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = 9100;
const server = http.createServer();
const wss = new WebSocketServer({ server });

let msgCount = 0;
let startTime;
const DURATION_MS = 5000;

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    msgCount++;
    ws.send(data); // echo
  });
});

server.listen(PORT, () => {
  console.log(`Node ws server on ${PORT}`);

  // Measure memory before clients
  const memBefore = process.memoryUsage();
  console.log(`RSS before clients: ${(memBefore.rss / 1024 / 1024).toFixed(1)}MB`);
  console.log(`Heap used: ${(memBefore.heapUsed / 1024 / 1024).toFixed(1)}MB`);

  // Connect 10 clients and send messages
  const WebSocket = require("ws");
  const clients = [];
  let connected = 0;

  for (let i = 0; i < 10; i++) {
    const c = new WebSocket(`ws://localhost:${PORT}`);
    clients.push(c);
    c.on("open", () => {
      connected++;
      if (connected === 10) startBenchmark();
    });
  }

  function startBenchmark() {
    const memAfter = process.memoryUsage();
    console.log(`RSS with 10 clients: ${(memAfter.rss / 1024 / 1024).toFixed(1)}MB`);

    startTime = Date.now();
    msgCount = 0;

    // Each client sends small JSON messages as fast as possible
    const msg = JSON.stringify({ type: "text.input", text: "hello world", ts: Date.now() });

    for (const c of clients) {
      c.on("message", () => {
        if (Date.now() - startTime < DURATION_MS) {
          c.send(msg);
        }
      });
      c.send(msg);
    }

    setTimeout(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      const memFinal = process.memoryUsage();
      console.log(`\n--- Node.js ws Results ---`);
      console.log(`Duration: ${elapsed.toFixed(1)}s`);
      console.log(`Total echoes: ${msgCount}`);
      console.log(`Msgs/sec: ${(msgCount / elapsed).toFixed(0)}`);
      console.log(`Final RSS: ${(memFinal.rss / 1024 / 1024).toFixed(1)}MB`);
      console.log(`Final heap: ${(memFinal.heapUsed / 1024 / 1024).toFixed(1)}MB`);

      clients.forEach(c => c.close());
      server.close();
      process.exit(0);
    }, DURATION_MS + 500);
  }
});
