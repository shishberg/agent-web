/**
 * Build-time integration check: imports the real package subpath
 * @shishberg/agent-web/session-protocol and inspects all locally-
 * referenced chunks for forbidden content (Vue runtime, CSS).
 *
 * Run after `npm run build`:  npm run test:package
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. Dynamic import of the real package subpath
// ---------------------------------------------------------------------------
const mod = await import("@shishberg/agent-web/session-protocol");

const functions = [
  "applyViewPatch",
  "createEmptySessionView",
  "piSnapshotToView",
  "piStreamEventToPatch",
] as const;

for (const name of functions) {
  if (typeof (mod as Record<string, unknown>)[name] !== "function") {
    console.error(`FAIL: ${name} is not a function`);
    process.exit(1);
  }
}

// Quick smoke: createEmptySessionView should return a view object
const view = mod.createEmptySessionView({ id: "test", title: "T", status: "idle" });
if (!view || view.session?.id !== "test") {
  console.error("FAIL: createEmptySessionView returned unexpected value");
  process.exit(1);
}

console.log("✓ Package self-reference import works, all 4 adapters are callable");

// ---------------------------------------------------------------------------
// 2. Bundle inspection — walk entrypoint and all local chunks
// ---------------------------------------------------------------------------
const seen = new Set<string>();

function walkBundle(entryPath: string): string[] {
  const contents: string[] = [];
  const stack = [resolve(root, entryPath)];

  while (stack.length > 0) {
    const filePath = stack.pop()!;
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    const source = readFileSync(filePath, "utf-8");
    contents.push(source);

    // Find relative chunk imports:  import { ... } from "./chunk-hash.js"
    const importRE = /from\s+"(\.\/[^"]+\.js)"/g;
    let match: RegExpExecArray | null;
    while ((match = importRE.exec(source)) !== null) {
      stack.push(resolve(dirname(filePath), match[1]));
    }
  }

  return contents;
}

const allSources = walkBundle("dist/package/session-protocol.js");
const combined = allSources.join("\n");

const forbiddenPatterns: [RegExp, string][] = [
  [/\bcreateApp\b/, "Vue createApp"],
  [/\bcreateElementVNode\b/, "Vue createElementVNode"],
  [/\bvue\b/i, "Vue identifier"],
  [/\.css\b/, "CSS reference"],
];

let failed = false;
for (const [re, label] of forbiddenPatterns) {
  if (re.test(combined)) {
    console.error(`FAIL: Forbidden content found in bundle: ${label}`);
    failed = true;
  }
}

if (!failed) {
  console.log(`✓ Bundle inspection passed (${seen.size} chunk(s))`);
} else {
  process.exit(1);
}

console.log("✓ All checks passed");
