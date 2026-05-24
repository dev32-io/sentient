#!/bin/bash
echo "=== Startup Time Benchmark ==="

echo "--- Node.js ---"
for i in 1 2 3; do
  /usr/bin/time -f "%e seconds" node -e "console.log(\"ready\")" 2>&1 | tail -1
done

echo "--- Bun ---"
for i in 1 2 3; do
  /usr/bin/time -f "%e seconds" bun -e "console.log(\"ready\")" 2>&1 | tail -1
done

echo ""
echo "=== TypeScript Execution ==="
cat > /tmp/test-ts.ts << TS
const x: number = 42;
interface Foo { bar: string }
const f: Foo = { bar: "hello" };
console.log(x, f.bar);
TS

echo "--- Node.js (needs tsx/tsc) ---"
/usr/bin/time -f "%e seconds" node --experimental-strip-types /tmp/test-ts.ts 2>&1

echo "--- Bun ---"
/usr/bin/time -f "%e seconds" bun /tmp/test-ts.ts 2>&1
