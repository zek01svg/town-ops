const lintStagedConfig = {
  '*.{js,jsx,ts,tsx}': [
    'eslint --config tooling/eslint/eslint.config.js --quiet --fix',
    'prettier --config tooling/prettier/prettier.config.js --write',
  ],
  '*.{json,css,md,html}': [
    'prettier --config tooling/prettier/prettier.config.js --write',
  ],
  '*.py': ['uv run ruff check --fix', 'uv run ruff format'],
};

export default lintStagedConfig;
