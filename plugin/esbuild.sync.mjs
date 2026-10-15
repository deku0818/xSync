// Adapted from the official sample plugin's esbuild configuration (0BSD).
import * as esbuild from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const out = `plugin/dist/${manifest.id}`;
await mkdir(out, { recursive: true });
const context = await esbuild.context({
  banner: { js: "/* GENERATED FILE. xSync plugin; based on obsidianmd/obsidian-sample-plugin (0BSD). */" },
  entryPoints: ["plugin/src/sync-main.ts"], bundle: true, external: ["obsidian", "@electron/remote", "node:buffer"],
  platform: "browser", format: "cjs", target: "es2021", logLevel: "info",
  sourcemap: process.argv.includes("--watch") ? "inline" : false,
  treeShaking: true, outfile: `${out}/main.js`, metafile: true,
});
const result = await context.rebuild();
for (const o of Object.values(result.metafile.outputs)) {
  for (const dep of o.imports) if (dep.external && !["obsidian", "@electron/remote", "node:buffer"].includes(dep.path)) throw new Error(`Forbidden runtime dependency: ${dep.path}`);
}
for (const [name, input] of Object.entries(result.metafile.inputs)) {
  for (const dep of input.imports) if (["@electron/remote", "node:buffer"].includes(dep.path) && !name.startsWith("plugin/src/desktop/")) throw new Error(`Desktop dependency leaked into ${name}`);
}
await copyFile("manifest.json", `${out}/manifest.json`);
await copyFile("LICENSE", `${out}/LICENSE`);
await copyFile("plugin/styles.css", `${out}/styles.css`);
await copyFile("plugin/licenses/obsidian-sample-plugin-0BSD.txt", `${out}/TEMPLATE-LICENSE.txt`);
let notices = await readFile("plugin/licenses/libsodium-ISC.txt", "utf8");
for (const name of ["dexie", "zod", "re2js"]) {
  for (const file of ["LICENSE", "LICENSE.txt", "LICENSE.md"]) {
    try { notices += `\n\n${name}\n${await readFile(`node_modules/${name}/${file}`, "utf8")}`; break; } catch { /* next license spelling */ }
  }
}
await writeFile(`${out}/THIRD-PARTY-NOTICES.txt`, notices);
if (process.argv.includes("--watch")) await context.watch(); else await context.dispose();
