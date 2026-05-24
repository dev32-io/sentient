const { execSync } = require("child_process");

function measure(cmd, label) {
  const results = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    execSync(cmd, { stdio: "pipe" });
    results.push(performance.now() - start);
  }
  results.sort((a, b) => a - b);
  const median = results[2];
  console.log(`${label}: ${median.toFixed(0)}ms median (${results.map(r => r.toFixed(0)).join(", ")})`);
}

measure("node -e \"process.exit(0)\"", "Node.js cold start");
measure("bun -e \"process.exit(0)\"", "Bun cold start");

// TS execution
const fs = require("fs");
fs.writeFileSync("/tmp/bench-ts.ts", "const x: number = 42; console.log(x);");
measure("node --experimental-strip-types /tmp/bench-ts.ts", "Node.js TS (strip-types)");
measure("bun /tmp/bench-ts.ts", "Bun TS");
