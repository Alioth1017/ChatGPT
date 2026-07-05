/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Runtime dependency installer.
// The VSIX ships WITHOUT native/heavy deps (onnxruntime-node, sharp,
// @huggingface/*). On first activation we download them from the npm registry
// into globalStorage/runtime-deps/node_modules and hook module resolution so
// `import("@huggingface/transformers")` etc. resolve from there.
// In dev (real node_modules present) this is a no-op.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as crypto from "crypto";

const REGISTRY = "https://registry.npmjs.org";

// Roots pinned to the versions in package.json. Transitives are resolved live.
const ROOTS: [name: string, range: string][] = [
  ["@huggingface/transformers", "4.2.0"],
  ["@huggingface/hub", "2.13.2"],
];

// Deps we never need at runtime (postinstall-only / web-only).
const DROP_DEPS: Record<string, string[]> = {
  "@huggingface/transformers": ["onnxruntime-web"],
  "onnxruntime-node": ["adm-zip", "global-agent"],
};

// Package names the require-hook is allowed to redirect (top-level externals).
const HOOKED = ["@huggingface/", "onnxruntime-node", "sharp"];

let rootDir: string | undefined; // <globalStorage>/runtime-deps
let readyP: Promise<boolean> | null = null;

/** sharp/libvips platform key, e.g. win32-x64, darwin-arm64, linuxmusl-x64. */
function platformKey(): string {
  if (process.platform !== "linux") return `${process.platform}-${process.arch}`;
  const glibc = (process.report?.getReport() as any)?.header?.glibcVersionRuntime;
  return `linux${glibc ? "" : "musl"}-${process.arch}`;
}

// ---- tiny semver (enough for ^ ~ >= exact * used by this closed dep set) ----
function parseV(v: string): number[] {
  return v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
}
function cmpV(a: string, b: string): number {
  const x = parseV(a), y = parseV(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  // A release beats a prerelease of the same triple.
  return (a.includes("-") ? 0 : 1) - (b.includes("-") ? 0 : 1);
}
function satisfies(v: string, range: string): boolean {
  range = range.trim();
  if (!range || range === "*" || range === "latest") return true;
  // "a || b" → any; "a b" → all
  if (range.includes("||")) return range.split("||").some((r) => satisfies(v, r));
  const parts = range.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.every((r) => satisfies(v, r));
  const m = range.match(/^([\^~]|>=|<=|>|<)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
  if (!m) return false;
  const op = m[1] || "";
  const base = [parseInt(m[2], 10), m[3] === undefined || m[3] === "x" || m[3] === "*" ? 0 : parseInt(m[3], 10), m[4] === undefined || m[4] === "x" || m[4] === "*" ? 0 : parseInt(m[4], 10)];
  const ver = parseV(v);
  const c = ver[0] !== base[0] ? ver[0] - base[0] : ver[1] !== base[1] ? ver[1] - base[1] : ver[2] - base[2];
  switch (op) {
    case ">=": return c >= 0;
    case "<=": return c <= 0;
    case ">": return c > 0;
    case "<": return c < 0;
    case "^": return c >= 0 && ver[0] === base[0];
    case "~": return c >= 0 && ver[0] === base[0] && ver[1] === base[1];
    default: // exact or x-range
      if (m[3] === undefined || m[3] === "x" || m[3] === "*") return ver[0] === base[0];
      if (m[4] === undefined || m[4] === "x" || m[4] === "*") return ver[0] === base[0] && ver[1] === base[1];
      return c === 0 && !v.includes("-");
  }
}

// ---- registry ----
const metaCache = new Map<string, any>();
async function pkgMeta(name: string): Promise<any> {
  let p = metaCache.get(name);
  if (!p) {
    p = fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    }).then((r) => {
      if (!r.ok) throw new Error(`registry ${name}: HTTP ${r.status}`);
      return r.json();
    });
    metaCache.set(name, p);
  }
  return p;
}
async function pickVersion(name: string, range: string): Promise<any> {
  const meta = await pkgMeta(name);
  const all = Object.keys(meta.versions);
  let best: string | null = null;
  for (const v of all) {
    if (!satisfies(v, range)) continue;
    if (!best || cmpV(v, best) > 0) best = v;
  }
  if (!best) best = meta["dist-tags"]?.latest;
  if (!best) throw new Error(`no version of ${name} satisfies "${range}"`);
  return meta.versions[best];
}

// ---- minimal tar extractor (npm tgz: ustar + GNU longname) ----
function untar(tarBuf: Buffer, destDir: string, filter?: (name: string) => boolean) {
  const destRoot = path.resolve(destDir);
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(off, off + 512);
    if (!header.some((b) => b !== 0)) break; // end blocks
    let name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/s, "");
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(header.toString("utf8", 124, 136).trim(), 8) || 0;
    const mode = parseInt(header.toString("utf8", 100, 108).trim(), 8) || 0o644;
    const type = String.fromCharCode(header[156]);
    const body = tarBuf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = body.toString("utf8").replace(/\0.*$/s, ""); continue; }
    if (longName) { name = longName; longName = null; }
    if (type !== "0" && type !== "") continue; // regular files only
    name = name.replace(/^[^/]+\//, ""); // strip "package/" root
    if (!name || (filter && !filter(name))) continue;
    const dest = path.resolve(destRoot, name);
    if (dest !== destRoot && !dest.startsWith(destRoot + path.sep)) continue; // traversal guard
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, { mode: mode & 0o111 ? 0o755 : 0o644 });
  }
}

async function downloadAndExtract(ver: any, destDir: string) {
  const res = await fetch(ver.dist.tarball);
  if (!res.ok) throw new Error(`download ${ver.name}: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  // Verify integrity (sha512-...base64).
  const integ: string = ver.dist.integrity || "";
  if (integ.startsWith("sha512-")) {
    const got = crypto.createHash("sha512").update(gz).digest("base64");
    if (got !== integ.slice(7)) throw new Error(`integrity mismatch for ${ver.name}@${ver.version}`);
  }
  // ORT ships every platform's binaries (~260MB); keep only ours.
  const ortKeep = `/${process.platform}/${process.arch}/`;
  const filter = ver.name === "onnxruntime-node"
    ? (n: string) => !/^bin\/napi-v\d+\//.test(n) || n.includes(ortKeep)
    : undefined;
  untar(zlib.gunzipSync(gz), destDir, filter);
}

/** Resolve the flat dependency tree (name → picked version manifest). */
async function resolveTree(): Promise<Map<string, any>> {
  const key = platformKey();
  const picked = new Map<string, any>();
  const queue: [string, string][] = [...ROOTS];
  while (queue.length) {
    const [name, range] = queue.shift()!;
    if (picked.has(name)) continue; // first wins (flat install)
    const ver = await pickVersion(name, range);
    picked.set(name, ver);
    const drop = new Set(DROP_DEPS[ver.name] || []);
    const deps: Record<string, string> = { ...(ver.dependencies || {}) };
    // Platform-specific optional deps (sharp → @img/sharp-*, libvips).
    for (const [n, r] of Object.entries(ver.optionalDependencies || {})) {
      if (n.startsWith("@img/") && n.endsWith(`-${key}`)) deps[n] = r as string;
    }
    for (const [n, r] of Object.entries(deps)) {
      if (!drop.has(n)) queue.push([n, r]);
    }
  }
  return picked;
}

async function install(dir: string): Promise<void> {
  const marker = path.join(dir, ".installed.json");
  const stamp = JSON.stringify({ v: 1, roots: ROOTS, key: platformKey() });
  try {
    if (fs.readFileSync(marker, "utf8") === stamp) return; // already installed
  } catch { /* not installed yet */ }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "OpenCursor: downloading local AI runtime (one-time)" },
    async (progress) => {
      const tree = await resolveTree();
      const nm = path.join(dir, "node_modules");
      fs.rmSync(nm, { recursive: true, force: true }); // clean partial installs
      let done = 0;
      for (const ver of tree.values()) {
        progress.report({ message: `${ver.name}@${ver.version} (${++done}/${tree.size})` });
        await downloadAndExtract(ver, path.join(nm, ver.name));
      }
      fs.writeFileSync(marker, stamp);
    }
  );
}

/** Redirect failed resolutions of our externals into runtime-deps. */
function installRequireHook(root: string) {
  const Module: any = require("module");
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: any[]) {
    try {
      return orig.call(this, request, ...rest);
    } catch (err) {
      if (HOOKED.some((p) => request === p || request.startsWith(p))) {
        try { return require.resolve(request, { paths: [root] }); } catch { /* fall through */ }
      }
      throw err;
    }
  };
}

/** Call once at activation. Non-blocking; kicks off install in the background. */
export function initRuntimeDeps(storageDir: string): void {
  rootDir = path.join(storageDir, "runtime-deps");
  installRequireHook(rootDir);
}

/**
 * Ensure heavy deps are importable. Resolves true when ready.
 * Await this before importing @huggingface/transformers, @huggingface/hub,
 * sharp or onnxruntime-node.
 */
export function ensureRuntimeDeps(): Promise<boolean> {
  if (!readyP) {
    readyP = (async () => {
      // Dev / bundled-node_modules case: already resolvable → nothing to do.
      try { require.resolve("@huggingface/transformers"); return true; } catch { /* need install */ }
      if (!rootDir) return false;
      try {
        fs.mkdirSync(rootDir, { recursive: true });
        await install(rootDir);
        return true;
      } catch (e: any) {
        readyP = null; // allow retry on next call
        console.error("[runtimeDeps] install failed:", e);
        vscode.window.showErrorMessage(`OpenCursor: failed to download AI runtime: ${e?.message || e}`);
        return false;
      }
    })();
  }
  return readyP;
}

// Self-check: OPENCURSOR_SELFCHECK=1 node -e "require('./dist/extension.js')"
if (process.env.OPENCURSOR_SELFCHECK) {
  const assert = (c: boolean, m: string) => { if (!c) throw new Error("selfcheck: " + m); };
  assert(satisfies("1.27.0", "^1.24.0"), "caret");
  assert(!satisfies("2.0.0", "^1.24.0"), "caret major");
  assert(satisfies("1.2.9", "~1.2.3") && !satisfies("1.3.0", "~1.2.3"), "tilde");
  assert(satisfies("3.1.0", ">=2.0.0") && satisfies("5.0.0", "^4.0.0 || ^5.0.0"), "range ops");
  assert(cmpV("1.10.0", "1.9.9") > 0, "cmp numeric");
  console.log("[runtimeDeps] selfcheck OK");
}
