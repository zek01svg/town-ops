const lintStagedConfig = {
  "*.{js,jsx,ts,tsx}": [
    "eslint --config tooling/eslint/eslint.config.mjs --quiet --fix",
    "prettier --write",
  ],
  "*.{json,css,md,html}": ["prettier --write"],
  "*.py": ["uv run ruff check --fix", "uv run ruff format"],
};

export default lintStagedConfig;
