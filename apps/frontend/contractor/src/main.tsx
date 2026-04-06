import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";

import { DevTools } from "./providers/devtools";
import { getQueryClient } from "./providers/get-query-client";
// Import the auto-generated route tree
import { routeTree } from "./routeTree.gen";

import "./globals.css";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_FRONTEND_DSN,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration(),
  ],
  tracesSampleRate: 1.0,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});

const router = createRouter({
  routeTree,
  context: {
    queryClient: getQueryClient(),
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");

if (root) {
  const queryClient = getQueryClient();

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <DevTools router={router} />
      </QueryClientProvider>
    </React.StrictMode>
  );
}
