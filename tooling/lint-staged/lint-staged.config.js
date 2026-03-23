const lintStagedConfig = {
  "*.{js,jsx,ts,tsx}": [
    "pnpm oxlint --config tooling/oxlint/oxlint.config.ts --quiet --fix",
    "pnpm oxfmt --config tooling/oxfmt/.oxfmtrc.json --write",
  ],
  "*.{json,css,md,html,toml}": [
    "pnpm oxfmt --config tooling/oxfmt/.oxfmtrc.json --write",
  ],
  "*.py": ["uv run ruff check --fix", "uv run ruff format"],
};

export default lintStagedConfig;
