const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { NpmParser } = require("../../dist/parsers/npm-parser.js");

test("NpmParser uses package-lock versions for direct dependencies", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "devguard-npm-parser-test-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    dependencies: {
      leftpad: "^1.0.0",
    },
    devDependencies: {
      typescript: "^5.0.0",
    },
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(repoDir, "package-lock.json"), JSON.stringify({
    name: "fixture",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture",
        dependencies: {
          leftpad: "^1.0.0",
        },
        devDependencies: {
          typescript: "^5.0.0",
        },
      },
      "node_modules/leftpad": {
        version: "1.3.0",
      },
      "node_modules/typescript": {
        version: "5.9.3",
        dev: true,
      },
      "node_modules/transitive": {
        version: "2.0.0",
      },
    },
  }, null, 2), "utf8");

  const result = await new NpmParser().parse(repoDir);

  assert.equal(result.error, undefined);
  assert.equal(result.dependencies.find((dependency) => dependency.name === "leftpad").version, "1.3.0");
  assert.equal(result.dependencies.find((dependency) => dependency.name === "typescript").version, "5.9.3");
  assert.equal(result.dependencies.find((dependency) => dependency.name === "transitive").version, "2.0.0");
});
