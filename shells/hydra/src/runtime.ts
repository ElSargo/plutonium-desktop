// The native packages T3 Code's server bundle keeps external (node-pty, fff,
// the keyring), installed into <stage>/node_modules the way T3's own CLI
// archive installs them (scripts/build-cli-archive.ts, stageRuntimeExternals),
// with T3's own lists, so the bundle carries what T3's release would.
//
//   node bundle/t3-runtime.ts <T3 Code checkout> <stage>
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [t3, stage] = process.argv.slice(2);
if (!t3 || !stage) throw new Error("usage: t3-runtime.ts <T3 Code checkout> <stage>");

const artifact = await import(join(t3, "scripts/build-desktop-artifact.ts"));
const { selectCliRuntimeExternalDependencies } = await import(join(t3, "scripts/lib/cli-external-packages.ts"));
const { resolveCatalogDependencies } = await import(join(t3, "scripts/lib/resolve-catalog.ts"));
const { parse } = await import(createRequire(join(t3, "packages/shared/package.json")).resolve("yaml"));

const rootPackage = JSON.parse(readFileSync(join(t3, "package.json"), "utf8"));
const serverPackage = JSON.parse(readFileSync(join(t3, "apps/server/package.json"), "utf8"));
const workspace = parse(readFileSync(join(t3, "pnpm-workspace.yaml"), "utf8"));
const catalog = workspace.catalog ?? {};
const serverDependencies = resolveCatalogDependencies(serverPackage.dependencies, catalog, "apps/server");
// The versions T3's own install has (its lockfile's), not the newest a range
// allows: T3's patches name exact versions (node-pty@1.2.0-beta.15), and a
// newer one leaves them unused, which pnpm refuses.
const lock = parse(readFileSync(join(t3, "pnpm-lock.yaml"), "utf8"));
const locked: Record<string, { version: string }> = lock.importers?.["apps/server"]?.dependencies ?? {};
// "1.2.0-beta.15(patch_hash=…)" → "1.2.0-beta.15"
const installed = (name: string, range: string) => locked[name]?.version.replace(/\(.*$/, "") ?? range;
const dependencies = Object.fromEntries(Object.entries({
  ...selectCliRuntimeExternalDependencies(serverDependencies),
  ...artifact.resolveFffNativeDependencies("linux", "x64", serverDependencies["@ff-labs/fff-node"]),
}).map(([name, range]) => [name, installed(name, range as string)]));
const patchedDependencies = artifact.createStagePatchedDependencies(workspace.patchedDependencies ?? {}, dependencies);

writeFileSync(join(stage, "package.json"), JSON.stringify({
  name: "t3-runtime", private: true, packageManager: rootPackage.packageManager, dependencies,
}, null, 2) + "\n");
// YAML is a superset of JSON.
writeFileSync(join(stage, "pnpm-workspace.yaml"), JSON.stringify({
  ...artifact.createStageWorkspaceConfig({
    platform: "linux",
    arch: "x64",
    ...(workspace.allowBuilds ? { allowBuilds: workspace.allowBuilds } : {}),
    patchedDependencies,
    overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/server"),
  }),
  nodeLinker: "hoisted",
}, null, 2) + "\n");
if (Object.keys(patchedDependencies).length > 0) cpSync(join(t3, "patches"), join(stage, "patches"), { recursive: true });

execFileSync(join(t3, "node_modules/.bin/vp"), [...artifact.STAGE_INSTALL_ARGS], { cwd: stage, stdio: "inherit" });

// pnpm's bookkeeping, and node-pty's prebuilds for other platforms (58 MB).
const prebuilds = join(stage, "node_modules/node-pty/prebuilds");
const foreign = existsSync(prebuilds) ? readdirSync(prebuilds).filter((entry) => entry !== "linux-x64") : [];
for (const entry of [
  "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "patches",
  "node_modules/.pnpm", "node_modules/.modules.yaml", "node_modules/.pnpm-workspace-state-v1.json",
  ...foreign.map((entry) => `node_modules/node-pty/prebuilds/${entry}`),
]) rmSync(join(stage, entry), { recursive: true, force: true });
// Every .bin: symlinks to things nothing runs. And the musl builds of native
// packages (fff names both): the bundle is for glibc.
(function prune(dir: string) {
  for (const entry of readdirSync(dir)) {
    const child = join(dir, entry);
    if (entry === ".bin" || entry.endsWith("-linux-x64-musl")) rmSync(child, { recursive: true, force: true });
    else if (statSync(child, { throwIfNoEntry: false })?.isDirectory()) prune(child);
  }
})(join(stage, "node_modules"));
