import { build } from "esbuild";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const out = "plugin/dist/obsidian-sync-probe";
await mkdir(out, { recursive: true });
const common = { bundle: true, platform: "browser", target: "safari15", minify: false, metafile: true, logLevel: "warning" };
const worker = await build({ ...common, entryPoints: ["plugin/src/probe/worker.ts"], format: "iife", write: false });
const main = await build({
  ...common, entryPoints: ["plugin/src/main.ts"], format: "cjs", external: ["obsidian"], outfile: `${out}/main.js`,
  plugins: [{ name: "inline-probe-worker", setup(builder) {
    builder.onResolve({ filter: /^probe-worker-source$/ }, () => ({ path: "worker", namespace: "probe" }));
    builder.onLoad({ filter: /.*/, namespace: "probe" }, () => ({ contents: `export default ${JSON.stringify(worker.outputFiles[0].text)}`, loader: "js" }));
  } }],
});
const browser = await build({
  ...common, entryPoints: ["tests/probe/browser-smoke.ts"], format: "iife", outfile: "tests/probe/dist/browser-smoke.js",
  plugins: [{ name: "inline-browser-worker", setup(builder) {
    builder.onResolve({ filter: /^probe-worker-source$/ }, () => ({ path: "worker", namespace: "probe" }));
    builder.onLoad({ filter: /.*/, namespace: "probe" }, () => ({ contents: `export default ${JSON.stringify(worker.outputFiles[0].text)}`, loader: "js" }));
  } }],
});
// Fail on any bundled external runtime import except the host's Obsidian API.
for (const result of [worker, main, browser]) {
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dep of output.imports) {
      if (dep.external && dep.path !== "obsidian") throw new Error(`Unexpected runtime dependency: ${dep.path}`);
    }
  }
}
await copyFile("plugin/manifest.json", `${out}/manifest.json`);
await copyFile("LICENSE", `${out}/LICENSE`);
const licenses = await Promise.all(["dexie", "libsodium-sumo", "libsodium-wrappers-sumo"].map(async name => {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"));
  let body;
  for (const path of ["LICENSE", "LICENSE.txt", "LICENSE.md"]) {
    try { body = await readFile(`node_modules/${name}/${path}`, "utf8"); break; } catch { /* try packaged name */ }
  }
  // libsodium's NPM packages declare ISC but do not ship the license file.
  if (!body && name.startsWith("libsodium")) body = await readFile("plugin/licenses/libsodium-ISC.txt", "utf8");
  if (!body) throw new Error(`Missing license text for ${name}`);
  return `${name} ${pkg.version} (${pkg.license})\n${body}`;
}));
await writeFile(`${out}/THIRD-PARTY-NOTICES.txt`, licenses.join("\n\n"));
await writeFile("plugin/dist/probe-metafile.json", JSON.stringify({ worker: worker.metafile, main: main.metafile }, null, 2));
console.log(`Built ${out} (development probe only; no Vault installed/changed)`);
