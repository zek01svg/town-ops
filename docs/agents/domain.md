# Domain Docs

Engineering skills should consume this repo's domain documentation as follows.

## Before exploring, read these

- `CONTEXT.md` at the repo root, if it exists.
- `docs/adr/`, reading ADRs relevant to the area being changed.

If these files do not exist, proceed silently. Create them only when domain terms or architectural decisions are actually resolved.

## Use the glossary's vocabulary

When naming a domain concept, use the term defined in `CONTEXT.md`. If the needed concept is missing, note it for domain modeling.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
