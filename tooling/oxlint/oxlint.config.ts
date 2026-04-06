import { defineConfig } from "oxlint";

export default defineConfig({
  // 1. Core Options
  options: {
    typeAware: true,
  },

  // 2. Native Plugins
  plugins: ["typescript", "react", "jsx-a11y", "unicorn", "import", "promise"],

  // 3. Rule Categories
  categories: {
    correctness: "error",
    suspicious: "warn",
    perf: "warn",
  },

  env: {
    es2024: true,
  },

  ignorePatterns: [
    "node_modules/**",
    "dist/**",
    "build/**",
    ".hono/**",
    "coverage/**",
    "vite.config.ts.timestamp-*",
    "**/*.py",
    "routeTree.gen.ts",
  ],

  // 6. Global Rules (Tweaks to standard categories)
  rules: {
    "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    "no-debugger": "error",

    // Type-aware rules (Enabled via options.typeAware)
    "typescript/no-floating-promises": "warn",
    "typescript/no-misused-promises": "warn",

    // Unicorn has great best practices but can be overly opinionated out of the box.
    "unicorn/no-null": "off",

    // --- Added from previous ESLint config ---
    "no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "typescript/consistent-type-imports": [
      "warn",
      { prefer: "type-imports", fixStyle: "separate-type-imports" },
    ],
    "typescript/no-unnecessary-condition": [
      "warn",
      { allowConstantLoopConditions: true },
    ],
    "typescript/no-non-null-assertion": "error",
    "typescript/no-explicit-any": "warn",

    // Import rules
    "import/no-duplicates": "error",
    "import/first": "error",
    "import/extensions": "off",
    "import/consistent-type-specifier-style": ["error", "prefer-top-level"],

    // Restrictions
    "no-restricted-imports": [
      "error",
      {
        name: "zod",
        message: "Use `import { z } from 'zod/v4'` instead to ensure v4.",
      },
    ],

    "react/react-in-jsx-scope": "off",
    // TanStack Form uses children-as-prop render pattern — not a React anti-pattern
    "react/no-children-prop": "off",
    // Custom Shadcn form components associate labels internally
    "jsx-a11y/label-has-associated-control": "off",
  },

  // 7. Environment-Specific Overrides
  overrides: [
    {
      // Frontend: React + Vite
      files: ["apps/frontend/**/*.ts", "apps/frontend/**/*.tsx"],
      env: {
        browser: true,
      },
      rules: {
        "react/rules-of-hooks": "error",
        "react/exhaustive-deps": "warn",

        // React 17+ New JSX Transform
        "react/react-in-jsx-scope": "off",

        // Strict accessibility checks
        "jsx-a11y/alt-text": "error",
        "jsx-a11y/anchor-is-valid": "warn",
        // TanStack Form uses children-as-prop render pattern — not a React anti-pattern here
        "react/no-children-prop": "off",
        // Custom form components wrap labels internally — association is handled by the component
        "jsx-a11y/label-has-associated-control": "off",
      },
    },
    {
      // Backend: Hono + Drizzle ORM
      files: [
        "apps/atoms/**/*.ts",
        "apps/composites/**/*.ts",
        "packages/**/*.ts",
      ],
      env: {
        node: true,
      },
      rules: {
        // Prevent accidental browser APIs in the backend
        "no-restricted-globals": ["error", "window", "document", "navigator"],
      },
    },
  ],
});
