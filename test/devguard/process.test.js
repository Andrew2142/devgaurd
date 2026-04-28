const test = require("node:test");
const assert = require("node:assert/strict");

const { runCommandAsync } = require("../../dist/utils/process.js");

test("runCommandAsync enforces the combined output buffer limit", async () => {
  const result = await runCommandAsync(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(1024));"],
    { maxBufferBytes: 16, timeoutMs: 30000 },
  );

  assert.equal(result.error && result.error.code, "ENOBUFS");
});
