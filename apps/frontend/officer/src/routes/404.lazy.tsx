import { Link, createLazyFileRoute } from "@tanstack/react-router";

export const Route = createLazyFileRoute("/404")({
  component: ErrorPage,
});

export function ErrorPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-4">
      <h1 className="text-4xl font-black tracking-tighter text-primary">404</h1>
      <p className="text-muted-foreground font-medium">Page not found</p>
      <Link
        to="/"
        className="px-4 py-2 bg-primary text-primary-foreground font-bold rounded-lg hover:opacity-90 transition-opacity"
      >
        Go Home
      </Link>
    </div>
  );
}
