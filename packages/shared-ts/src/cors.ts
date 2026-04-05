const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
];

/**
 * Returns allowed CORS origins in development, null in production.
 * Production CORS is handled by Kong — services should skip the middleware
 * entirely when this returns null.
 */
export function corsOrigins(): string[] | null {
  if (process.env.NODE_ENV === "production") return null;

  const raw = process.env.CORS_ORIGINS;
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEV_ORIGINS;
}
