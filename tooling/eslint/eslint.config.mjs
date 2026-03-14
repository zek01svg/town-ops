import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import honoConfig from '@hono/eslint-config';
import queryPlugin from '@tanstack/eslint-plugin-query';
import * as drizzlePlugin from 'eslint-plugin-drizzle';
import importPlugin from 'eslint-plugin-import';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, '../../.gitignore');

const restrictEnvAccess = tseslint.config(
  {
    ignores: ['**/env.ts', '**/server/env.ts', '**/src/env.ts'],
  },
  {
    files: ['**/*.js', '**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            "Use `import { env } from 'env'` instead to ensure validated types.",
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          name: 'process',
          importNames: ['env'],
          message:
            "Use `import { env } from 'env'` instead to ensure validated types.",
        },
      ],
    },
  },
);

export default tseslint.config(
  includeIgnoreFile(gitignorePath),
  { ignores: ["**/*.config.*", "dist", "build", ".drizzle", "coverage"] },

  // 2. Base Configuration
  ...restrictEnvAccess,
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    files: ["**/*.js", "**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2020,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: path.resolve(__dirname, "../../"),
      },
    },
    plugins: {
      import: importPlugin,
      query: queryPlugin,
      react: reactPlugin,
      "simple-import-sort": simpleImportSort,
      drizzle: drizzlePlugin,
      security: securityPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "simple-import-sort/imports": "warn",
      "simple-import-sort/exports": "warn",
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-duplicates": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-misused-promises": [
        2,
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/no-unnecessary-condition": [
        "error",
        {
          allowConstantLoopConditions: true,
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "import/consistent-type-specifier-style": ["error", "prefer-top-level"],
      "import/extensions": [
        "error",
        "ignorePackages",
        {
          ts: "always",
          tsx: "always",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          name: "zod",
          message: "Use `import { z } from 'zod/v4'` instead to ensure v4.",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },

  // 3. Frontend Specific Config (src/)
  {
    files: ["../../apps/frontend/**/*.{ts,tsx}"], // <-- Traverse up to the root
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // 4. Backend Specific Config (server/)
  {
    files: ["../../apps/**/*.{ts,js}"], // <-- Traverse up to the root
    extends: [honoConfig],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
