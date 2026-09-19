import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/", "data/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Standalone probe/ops scripts (Node APIs, no DOM) — e.g. the A′
    // chat.db spike probe under infra/.
    files: ["infra/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
      },
    },
  },
);
