import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Config isolada para testes de regras puras (não carrega o plugin do TanStack Start).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
