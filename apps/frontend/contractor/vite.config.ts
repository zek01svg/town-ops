import nodePath from "path";
import { fileURLToPath } from "url";

import tailwindcss from "@tailwindcss/vite";
import tanstackRouter from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);

export default defineConfig({
  server: {
    port: 5174,
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
        __dirname,
        "../../../packages/ui/src/components/ui"
      ),
      "@": nodePath.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "build",
  },
});
