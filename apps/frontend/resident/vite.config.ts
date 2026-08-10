import nodePath from "path";
import { fileURLToPath } from "url";

import tailwindcss from "@tailwindcss/vite";
import tanstackRouter from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

const configFilePath = fileURLToPath(import.meta.url);
const configDirectoryPath = nodePath.dirname(configFilePath);

export default defineConfig({
  server: {
    port: 5175,
    strictPort: true,
  },
  plugins: [
    tailwindcss(),
    react(),
    tanstackRouter({
      target: "react",
    }),
  ],
  resolve: {
    alias: {
      "@/components/ui": nodePath.resolve(
        configDirectoryPath,
        "../../../packages/ui/src/components/ui"
      ),
      "@": nodePath.resolve(configDirectoryPath, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "build",
  },
});
