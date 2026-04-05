# TownOps Frontend

This frontend app serves as the operational dashboard for town council officers.

## 🛠️ Tech Stack

This frontend leverages a modern, fully-typed React stack relying heavily on the TanStack ecosystem:

- **Routing:** `@tanstack/react-router` for type-safe file-based routing.
- **Data Fetching:** `@tanstack/react-query` for type-safe data fetching.
- **Form Management:** `@tanstack/react-form` combined with `@tanstack/zod-form-adapter`.
- **Validation:** `zod` for strict schema definitions that are synchronized with our backend composites.
- **Kanban Boards:** `react-kanban-kit` for performing drag-and-drop workflow updates on reports / cases.
- **Testing:** `vitest` with `jsdom` (config inherited from the workspace tooling `baseConfig`).
- **Styling:** Tailwind v4

## 🚀 Development

Running the application strictly mandates `<root>` dependencies to align. We use `pnpm` workspace tooling.

```bash
# Start frontend from the root
pnpm run dev --filter "@townops/frontend"

# Start frontend from frontend directory
cd apps/frontend
pnpm run dev
```
