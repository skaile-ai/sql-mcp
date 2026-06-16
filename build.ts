// Bundles the server to dist/server.js for the ai-assets upstream_pointer asset.
// node: builtins (incl. node:sqlite) are externalized; everything else is inlined.
const result = await Bun.build({
  entrypoints: ["src/server.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  minify: false,
  naming: "server.js",
});
if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
console.log("Built dist/server.js");

export {};
