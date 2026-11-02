import { build } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({
  root: path.join(root, "client"),
  configFile: false,
  base: "/instrument-lab/",
  build: { outDir: path.join(root, "dist"), emptyOutDir: true },
});
