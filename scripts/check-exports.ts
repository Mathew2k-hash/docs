/**
 * check-exports.ts
 *
 * Ensures every import path and named symbol documented in the MDX files
 * exists in the published @wraith-protocol/sdk package — for both ESM and CJS.
 *
 * Pipeline
 * ────────
 * 1. Walk every .mdx file and collect `import { … } from "@wraith-protocol/sdk…"` statements.
 * 2. Deduplicate into a map  specifier → Set<symbol>.
 * 3. Write two typed fixtures into a temp directory:
 *      fixture.esm.mts  — uses ES `import` (tests the "import" export condition)
 *      fixture.cjs.cts  — uses `require()` (tests the "require" export condition)
 * 4. Type-check both fixtures with tsc (skipLibCheck: false, strict: true).
 *    A missing named export surfaces as a compile error here.
 * 5. Execute both fixtures with `tsx` (no separate compile step needed).
 *    A symbol that compiled fine but is `undefined` at runtime is caught here.
 * 6. Exit 1 on any failure with a clear diff-friendly summary.
 *
 * Run
 * ───
 *   pnpm run check:exports
 */

import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

// ─── configuration ────────────────────────────────────────────────────────────

const PACKAGE_SCOPE = "@wraith-protocol/sdk";
const REPO_ROOT = process.cwd();
const IGNORED_DIRS = new Set([".git", ".github", "node_modules", ".next", "dist", "build"]);

/**
 * Pure type-level symbols (interfaces, type aliases).  tsc verifies them via
 * `import type { … }` in the ESM fixture; we skip the runtime defined-ness
 * check because they have no runtime representation.
 *
 * Extend this list if the docs add new type-only named exports.
 */
const TYPE_ONLY_SYMBOLS = new Set<string>([
  // EVM
  "HexString",
  "StealthKeys",
  "GeneratedStealthAddress",
  "Announcement",
  "MatchedAnnouncement",
  "StealthMetaAddress",
  // CKB
  "StealthCell",
  "MatchedStealthCell",
  // Stellar / Solana federation types
  "FederationRecord",
  "FederationError",
  "FederationErrorCode",
  "FederationCache",
  // Root sdk types
  "AnnouncementStream",
  "AnnouncementsStreamOptions",
  "WraithConfig",
  "AgentConfig",
  "AgentInfo",
  "ChatResponse",
  "ToolCall",
  "Balance",
  "Payment",
  "Invoice",
  "Schedule",
  "TxResult",
  "PrivacyReport",
  "Notification",
  "Conversation",
  "RetentionConfig",
  "ViewTagFilter",
  "StreamCacheOptions",
  "BackpressureOptions",
  "StreamError",
]);

// ─── MDX import extraction ────────────────────────────────────────────────────

type ImportEntry = {
  specifier: string; // e.g. "@wraith-protocol/sdk/chains/stellar"
  symbols: string[]; // named exports from that import statement
  file: string; // relative path of the source MDX
  line: number;
};

/**
 * Matches:
 *   import { A, B, C } from "@wraith-protocol/sdk"
 *   import type { T } from "@wraith-protocol/sdk/chains/evm"
 *   (also multiline braces)
 */
const IMPORT_RE =
  /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'](@wraith-protocol\/sdk[^"']*)["']/g;

async function extractImports(files: string[]): Promise<ImportEntry[]> {
  const entries: ImportEntry[] = [];

  for (const file of files) {
    const src = await readFile(file, "utf8");
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = IMPORT_RE.exec(src)) !== null) {
      const rawNames = m[1];
      const specifier = m[2];
      const line = src.slice(0, m.index).split("\n").length;

      const symbols = rawNames
        .split(",")
        .map((s) => s.replace(/\/\/[^\n]*/g, "").trim()) // strip inline comments
        .map((s) => s.replace(/\s+as\s+\S+/g, "").trim()) // strip "as alias" clauses
        .map((s) => s.replace(/^type\s+/, "").trim())      // strip inline "type " modifier
        .filter(Boolean);

      if (symbols.length > 0) {
        entries.push({ specifier, symbols, file: path.relative(REPO_ROOT, file), line });
      }
    }
  }

  return entries;
}

// ─── build specifier → symbol map ────────────────────────────────────────────

type ImportMap = Map<string, Set<string>>;

function buildImportMap(entries: ImportEntry[]): ImportMap {
  const map: ImportMap = new Map();
  for (const { specifier, symbols } of entries) {
    if (!map.has(specifier)) map.set(specifier, new Set());
    for (const s of symbols) map.get(specifier)!.add(s);
  }
  return map;
}

// ─── fixture source generators ────────────────────────────────────────────────

/**
 * ESM fixture (.mts).
 *
 * For each specifier we emit:
 *   import { val1, val2 } from "<specifier>";
 *   import type { Type1 } from "<specifier>";
 *   __check("<specifier>", "val1", val1);
 *
 * tsc validates the named imports against the package's .d.ts.
 * __check() catches runtime-undefined value exports.
 */
function buildEsmFixture(importMap: ImportMap): string {
  const out: string[] = [
    "// AUTO-GENERATED — do not edit",
    "// ESM fixture: tests the `import` export condition of @wraith-protocol/sdk",
    "",
    "function __check(spec: string, name: string, val: unknown): void {",
    "  if (val === undefined) throw new Error(`[ESM] ${spec} → '${name}' is undefined`);",
    "}",
    "",
  ];

  for (const [specifier, symbols] of importMap) {
    const values = [...symbols].filter((s) => !TYPE_ONLY_SYMBOLS.has(s));
    const types = [...symbols].filter((s) => TYPE_ONLY_SYMBOLS.has(s));

    if (values.length) out.push(`import { ${values.join(", ")} } from "${specifier}";`);
    if (types.length) out.push(`import type { ${types.join(", ")} } from "${specifier}";`);

    for (const v of values) {
      out.push(`__check("${specifier}", "${v}", ${v});`);
    }
    out.push("");
  }

  out.push("export {};");
  return out.join("\n");
}

/**
 * CJS fixture (.cts).
 *
 * Uses require() so Node loads the `require` export condition.
 * The `as typeof import(...)` cast gives tsc the package's declared types,
 * so missing exports are caught here too (not only at ESM).
 */
function buildCjsFixture(importMap: ImportMap): string {
  const out: string[] = [
    "// AUTO-GENERATED — do not edit",
    "// CJS fixture: tests the `require` export condition of @wraith-protocol/sdk",
    "",
    "function __check(spec: string, name: string, val: unknown): void {",
    "  if (val === undefined) throw new Error(`[CJS] ${spec} → '${name}' is undefined`);",
    "}",
    "",
  ];

  for (const [specifier, symbols] of importMap) {
    const values = [...symbols].filter((s) => !TYPE_ONLY_SYMBOLS.has(s));

    if (values.length) {
      // require() with the types from the package declarations
      out.push(
        `const { ${values.join(", ")} } = require("${specifier}") as typeof import("${specifier}");`,
      );
      for (const v of values) {
        out.push(`__check("${specifier}", "${v}", ${v});`);
      }
    }
    out.push("");
  }

  out.push("export {};");
  return out.join("\n");
}

// ─── package availability check ──────────────────────────────────────────────

/**
 * Return true if the npm package that owns `specifier` is installed.
 * For scoped packages like "@wraith-protocol/sdk-react" the package root is
 * node_modules/@wraith-protocol/sdk-react.
 * For sub-path exports like "@wraith-protocol/sdk/chains/evm" the package
 * root is node_modules/@wraith-protocol/sdk.
 */
function packageRootFromSpecifier(specifier: string): string {
  // Strip sub-path: "@scope/pkg/a/b" → "@scope/pkg"
  const parts = specifier.split("/");
  const pkgName = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")   // @scope/name
    : parts[0];                      // name
  return path.join(REPO_ROOT, "node_modules", pkgName);
}

async function isPackageInstalled(specifier: string): Promise<boolean> {
  const pkgRoot = packageRootFromSpecifier(specifier);
  try {
    await readFile(path.join(pkgRoot, "package.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}


function run(
  command: string,
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env: process.env, shell: false });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c));
    child.stderr.on("data", (c: Buffer) => (output += c));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

/** Run tsc against a single fixture file. Returns error output or null on success. */
async function typeCheck(fixturePath: string, tmpDir: string): Promise<string | null> {
  const tsconfigPath = path.join(tmpDir, `tsconfig-${path.basename(fixturePath)}.json`);
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022"],
      strict: true,
      skipLibCheck: false, // intentionally check package .d.ts files
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      noEmit: true,
    },
    include: [fixturePath],
  };

  await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2), "utf8");

  const { exitCode, output } = await run("pnpm", [
    "exec",
    "tsc",
    "--noEmit",
    "--project",
    tsconfigPath,
  ]);
  return exitCode === 0 ? null : output.trim();
}

/** Execute a TypeScript fixture directly via tsx. Returns error output or null. */
async function runWithTsx(fixturePath: string): Promise<string | null> {
  const { exitCode, output } = await run("pnpm", ["exec", "tsx", fixturePath]);
  return exitCode === 0 ? null : output.trim();
}

async function findMdxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return IGNORED_DIRS.has(entry.name) ? [] : findMdxFiles(full);
      return entry.isFile() && entry.name.endsWith(".mdx") ? [full] : [];
    }),
  );
  return nested.flat().sort();
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. Extract documented imports ─────────────────────────────────────────
  const mdxFiles = await findMdxFiles(REPO_ROOT);
  const importEntries = await extractImports(mdxFiles);
  const importMap = buildImportMap(importEntries);

  if (importMap.size === 0) {
    console.error(
      `No imports from "${PACKAGE_SCOPE}" found in any .mdx file.\n` +
        "Check that the docs exist and that PACKAGE_SCOPE matches the package name.",
    );
    process.exit(1);
  }

  // ── 1b. Filter out entry points whose package is not installed ─────────────
  // Companion packages (e.g. @wraith-protocol/sdk-react) are documented here
  // but are not dependencies of this repo. Skip them with a warning rather
  // than hard-failing — their exports are tested in their own packages.
  const skippedSpecifiers: string[] = [];
  const checkableMap: ImportMap = new Map();

  for (const [specifier, symbols] of importMap) {
    if (await isPackageInstalled(specifier)) {
      checkableMap.set(specifier, symbols);
    } else {
      skippedSpecifiers.push(specifier);
    }
  }

  // Print discovery summary
  const totalSymbols = [...checkableMap.values()].reduce((n, s) => n + s.size, 0);
  console.log(`Scanned ${mdxFiles.length} MDX file(s).\n`);

  if (skippedSpecifiers.length > 0) {
    console.log("⚠️  Skipped (package not installed in this repo):");
    for (const s of skippedSpecifiers) console.log(`  ${s}`);
    console.log();
  }

  console.log("Documented entry points to check:");
  for (const [specifier, symbols] of checkableMap) {
    console.log(`  ${specifier}`);
    for (const sym of symbols) {
      const tag = TYPE_ONLY_SYMBOLS.has(sym) ? " (type-only)" : "";
      console.log(`    • ${sym}${tag}`);
    }
  }
  console.log(
    `\nTotal: ${checkableMap.size} entry point(s), ${totalSymbols} unique symbol(s).\n`,
  );

  if (checkableMap.size === 0) {
    console.error("No installed entry points to check. Exiting.");
    process.exit(1);
  }

  // ── 2. Write fixtures into a temp dir ─────────────────────────────────────
  const tmpDir = await mkdtemp(path.join(tmpdir(), "wraith-exports-check-"));

  try {
    // Symlink node_modules so the package is resolvable inside the temp dir
    await symlink(path.join(REPO_ROOT, "node_modules"), path.join(tmpDir, "node_modules"), "dir").catch(
      () => undefined,
    );
    // package.json (type:module) satisfies Node's ESM resolution for .mts output
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "wraith-exports-fixture", type: "module" }),
      "utf8",
    );

    const esmFixture = path.join(tmpDir, "fixture.esm.mts");
    const cjsFixture = path.join(tmpDir, "fixture.cjs.cts");

    await writeFile(esmFixture, buildEsmFixture(checkableMap), "utf8");
    await writeFile(cjsFixture, buildCjsFixture(checkableMap), "utf8");

    const failures: Array<{ label: string; detail: string }> = [];

    // ── 3 & 4. Type-check and execute ESM fixture ──────────────────────────
    console.log("── ESM fixture ──────────────────────────────────");

    process.stdout.write("  tsc … ");
    const esmTypeErr = await typeCheck(esmFixture, tmpDir);
    if (esmTypeErr) {
      console.log("FAIL");
      failures.push({ label: "ESM type check (tsc)", detail: esmTypeErr });
    } else {
      console.log("ok");
      process.stdout.write("  tsx … ");
      const esmRunErr = await runWithTsx(esmFixture);
      if (esmRunErr) {
        console.log("FAIL");
        failures.push({ label: "ESM runtime (tsx)", detail: esmRunErr });
      } else {
        console.log("ok");
      }
    }

    // ── 5 & 6. Type-check and execute CJS fixture ──────────────────────────
    console.log("\n── CJS fixture ──────────────────────────────────");

    process.stdout.write("  tsc … ");
    const cjsTypeErr = await typeCheck(cjsFixture, tmpDir);
    if (cjsTypeErr) {
      console.log("FAIL");
      failures.push({ label: "CJS type check (tsc)", detail: cjsTypeErr });
    } else {
      console.log("ok");
      process.stdout.write("  tsx … ");
      const cjsRunErr = await runWithTsx(cjsFixture);
      if (cjsRunErr) {
        console.log("FAIL");
        failures.push({ label: "CJS runtime (tsx)", detail: cjsRunErr });
      } else {
        console.log("ok");
      }
    }

    // ── 7. Final verdict ───────────────────────────────────────────────────
    console.log();
    if (failures.length > 0) {
      console.error("━━━ EXPORT CHECK FAILED ━━━\n");
      for (const { label, detail } of failures) {
        console.error(`❌  ${label}\n`);
        console.error(detail);
        console.error();
      }
      console.error(
        "Docs and package exports diverge. Either:\n" +
          "  • Update the docs to match what the package actually exports, or\n" +
          "  • Add the missing export to @wraith-protocol/sdk.",
      );
      process.exit(1);
    }

    console.log("━━━ EXPORT CHECK PASSED ━━━");
    console.log(
      `All ${totalSymbols} symbol(s) across ${checkableMap.size} entry point(s) are present in both ESM and CJS.`,
    );
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
