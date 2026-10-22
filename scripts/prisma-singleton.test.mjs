import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/prisma.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  },
).outputText;

function createServerProcess(nodeEnv, existingClient) {
  const constructed = [];
  const context = vm.createContext({
    process: { env: { NODE_ENV: nodeEnv } },
    prisma: existingClient,
  });
  context.global = context;

  function loadIndependentBundle() {
    // Each bundle gets fresh module exports and its own Prisma constructor,
    // while sharing the server process global (not the module cache).
    const exports = {};
    const evaluate = vm.runInContext(
      `(function (exports, require) { ${compiled}\n})`,
      context,
    );
    evaluate(exports, (id) => {
      assert.equal(id, "@prisma/client");
      return {
        PrismaClient: class {
          constructor() {
            constructed.push(this);
          }
        },
      };
    });
    return exports;
  }

  return { constructed, context, loadIndependentBundle };
}

for (const nodeEnv of ["production", "development", "test"]) {
  test(`${nodeEnv} server bundles share one Prisma client and connection pool`, () => {
    const server = createServerProcess(nodeEnv);
    const firstBundle = server.loadIndependentBundle();
    for (let index = 0; index < 3; index += 1) {
      const nextBundle = server.loadIndependentBundle();
      assert.notEqual(nextBundle, firstBundle);
      assert.equal(nextBundle.prisma, firstBundle.prisma);
    }
    assert.equal(server.constructed.length, 1);
    assert.equal(server.context.prisma, firstBundle.prisma);
  });
}

test("production bundles reuse an already initialized process client", () => {
  const existingClient = {};
  const server = createServerProcess("production", existingClient);
  assert.equal(server.loadIndependentBundle().prisma, existingClient);
  assert.equal(server.loadIndependentBundle().prisma, existingClient);
  assert.equal(server.constructed.length, 0);
});
