// Stub: bypass JWK auth middleware in integration tests
export const jwk = () => (_c: unknown, next: () => Promise<void>) => next();
