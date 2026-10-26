import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const webpack = createRequire(require.resolve("react-scripts/package.json"))(
  "webpack"
);
process.env.REACT_APP_CLIENT = "userscript";
const { webpack: configure } = require("../../config-overrides.js");

const workerFactory = path.resolve("src/providers/workerFactory.js");

async function compile(root) {
  const configured = configure(
    {
      output: {},
      module: { parser: {} },
      optimization: {},
      resolve: { alias: {} },
      plugins: [],
    },
    "production"
  );
  const compiler = webpack({
    mode: "production",
    context: path.resolve("."),
    // Every real entry shares the fixture, as the real entries share providers.
    entry: Object.fromEntries(
      Object.keys(configured.entry).map((name) => [
        name,
        path.join(root, "entry.js"),
      ])
    ),
    module: configured.module,
    resolve: configured.resolve,
    output: {
      ...configured.output,
      path: path.join(root, "dist"),
      filename: "[name].js",
    },
    optimization: { ...configured.optimization, minimize: false },
    // The real guard and chunk limit, without HTML pages or the analysis report.
    plugins: configured.plugins.filter((plugin) =>
      ["LimitChunkCountPlugin", "SelfContainedEntriesPlugin"].includes(
        plugin.constructor.name
      )
    ),
  });
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) reject(error || closeError);
        else resolve(stats);
      });
    });
  });
}

// A dedicated worker global: messages to the page go to `outbox`.
function startWorker(source, outbox) {
  const listeners = [];
  const context = vm.createContext({
    postMessage: (data) => outbox(data),
    addEventListener: (type, listener) => {
      if (type === "message") listeners.push(listener);
    },
    // The heartbeat runs until the page terminates the worker.
    setInterval: (...args) => setInterval(...args).unref(),
    clearInterval,
    setTimeout,
    clearTimeout,
    Blob,
    TextEncoder,
    TextDecoder,
  });
  context.self = context;
  vm.runInContext(source, context);
  return (data) => listeners.forEach((listener) => listener({ data }));
}

test("userscript bundles lazy imports and the provider worker into its own file", async () => {
  await fs.mkdir("tmp", { recursive: true });
  const root = await fs.mkdtemp(path.resolve("tmp/userscript-chunks-"));
  try {
    await fs.writeFile(
      path.join(root, "entry.js"),
      `import { createProviderWorker } from ${JSON.stringify(workerFactory)};
globalThis.lazy = import("./lazy.js").then((m) => m.value);
globalThis.createProviderWorker = createProviderWorker;`
    );
    await fs.writeFile(path.join(root, "lazy.js"), "export const value = 42;");
    const stats = await compile(root);
    assert.equal(
      stats.hasErrors(),
      false,
      stats.toString({ all: false, errors: true })
    );
    const emitted = (
      await fs.readdir(path.join(root, "dist"), { recursive: true })
    ).filter((file) => file.endsWith(".js"));
    assert.deepEqual(emitted.sort(), [
      "kiss-translator.user.js",
      "main.js",
      "options.js",
    ]);

    const blobs = new Map();
    const workers = [];
    const page = vm.createContext({
      Blob: class {
        constructor(parts, options) {
          this.text = parts.join("");
          this.type = options?.type;
        }
      },
      URL: {
        createObjectURL(blob) {
          const url = `blob:host/${blobs.size}`;
          blobs.set(url, blob);
          return url;
        },
      },
      Worker: class {
        constructor(url) {
          // Anything but a blob URL would be fetched from the host page.
          assert.ok(blobs.has(String(url)), `worker URL ${url}`);
          this.url = String(url);
          workers.push(this);
        }
      },
      document: {
        getElementsByTagName() {
          throw new Error("Attempted to load a chunk through the host page");
        },
      },
    });
    page.self = page;
    vm.runInContext(
      await fs.readFile(
        path.join(root, "dist", "kiss-translator.user.js"),
        "utf8"
      ),
      page
    );
    assert.equal(await page.lazy, 42);

    page.createProviderWorker();
    page.createProviderWorker();
    assert.equal(workers.length, 2);
    const blob = blobs.get(workers[0].url);
    assert.equal(blob.type, "text/javascript");

    // The inlined source is a working provider sandbox, not just a string.
    let settle;
    const done = new Promise((resolve) => (settle = resolve));
    const send = startWorker(blob.text, (data) => {
      // Messages cross the worker boundary by structured clone.
      data = structuredClone(data);
      if (data.type === "result" || data.type === "error") settle(data);
    });
    send({
      type: "start",
      code: "exports.chat = (input) => ({ text: input.text + '!' })",
      handler: "chat",
      input: { text: "hi" },
      config: {},
      options: {},
    });
    assert.deepEqual(await done, { type: "result", result: { text: "hi!" } });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
