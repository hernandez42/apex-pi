// scripts/static-audit.mjs
// Quick checks: deleted-file imports, stub throws, suspicious patterns.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "E:/pi";
const TS_FILES = [];

function walk(d) {
  for (const e of readdirSync(d)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(d, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (e.endsWith(".ts")) TS_FILES.push(p);
  }
}
walk(ROOT);

const DELETED = [
  "from \"../llm/", "from \"../agent/loop", "from \"../tools/", "from \"../server.ts",
  "from \"../web.ts", "from \"../bootstrap\"", "from \"../web/", "from \"./llm/",
  "from \"./agent/loop", "from \"./tools/", "from \"./server.ts", "from \"./web.ts",
  "from \"./web/", "from \"./bootstrap\"",
];

let bad = 0;
for (const f of TS_FILES) {
  if (f.endsWith(".test.ts")) continue;
  const rel = relative(ROOT, f).replaceAll("\\", "/");
  const text = readFileSync(f, "utf8");
  for (const pat of DELETED) {
    if (text.includes(pat)) {
      console.log(`[DELETED-IMPORT] ${rel}  -> ${pat}`);
      bad++;
    }
  }
  if (text.includes("not implemented") || text.includes("throw new Error(\"stub")) {
    console.log(`[STUB] ${rel}`);
    bad++;
  }
  if (text.match(/^#\s*noinspection/m) || text.match(/eslint-disable/g)) {
    console.log(`[SUPPRESSION] ${rel}`);
  }
}

console.log(`\n${bad} issue(s) found across ${TS_FILES.length} files.`);
