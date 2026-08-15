#!/usr/bin/env bun
/**
 * Cloudflare R2 smoke test (PRS-140 Phase 8).
 *
 * Runs under Bun, never Node: production talks to R2 through `import
 * { S3Client } from "bun"` and there is no `@aws-sdk/client-s3` anywhere in
 * this repo, so an AWS-SDK version of this file would not be testing the same
 * client configuration the proof atom actually uses.
 *
 * It imports `src/storage.ts` itself rather than rebuilding an equivalent
 * client, so the endpoint/region/bucket wiring under test is literally the
 * deployed one. That module pulls in the atom's `env.ts`, which validates a
 * few unrelated vars; the placeholders below only satisfy that schema —
 * `storage.ts` opens no database connection and never reads them.
 *
 *   export S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
 *   export S3_BUCKET=townops-proofs S3_REGION=auto
 *   export S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
 *   bun apps/atoms/proof/scripts/smoke-r2.ts
 */
import { S3Client } from "bun";

process.env.DATABASE_URL ??= "postgres://smoke:smoke@127.0.0.1:5432/smoke";
process.env.PORT ??= "5000";
process.env.WORKER_SERVICE_TOKEN ??= "x".repeat(32);

const required = [
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET",
  "S3_REGION",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`FAIL   env   missing ${missing.join(", ")}`);
  process.exit(1);
}

const { storage } = await import("../src/storage");

let failures = 0;

function record(pass: boolean, check: string, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}   ${check.padEnd(24)} ${detail}`);
  if (!pass) failures += 1;
}

/** Asserts an operation is refused. A success here is the failure. */
async function expectRefused(check: string, operation: () => Promise<unknown>) {
  try {
    await operation();
    record(false, check, "operation SUCCEEDED but should have been refused");
  } catch (error) {
    record(
      true,
      check,
      `refused: ${error instanceof Error ? error.name : String(error)}`
    );
  }
}

// A single-byte-accurate payload, so the read-back comparison catches a
// truncating or re-encoding proxy rather than only a total failure. Shaped
// like what the proof atom actually stores.
const key = `smoke/${crypto.randomUUID()}.bin`;
const payload = crypto.getRandomValues(new Uint8Array(4096));

try {
  await storage.file(key).write(payload, { type: "image/png" });
  record(true, "upload", `wrote ${payload.byteLength} bytes to ${key}`);

  const stat = await storage.file(key).stat();
  record(
    stat.size === payload.byteLength,
    "metadata-read",
    `stat size=${stat.size} type=${stat.type}`
  );

  const readBack = new Uint8Array(await storage.file(key).arrayBuffer());
  const identical =
    readBack.byteLength === payload.byteLength &&
    readBack.every((byte, index) => byte === payload[index]);
  record(identical, "object-read", `read ${readBack.byteLength} bytes back`);

  // The production read path: `proofDto()` never hands out a bucket URL, it
  // signs the stored object path at read time. If this 200s but the unsigned
  // request below also 200s, the bucket is public and presigning is theatre.
  const presignedUrl = storage.presign(key, { expiresIn: 60 });
  const presigned = await fetch(presignedUrl);
  record(
    presigned.ok && presignedUrl.includes("X-Amz-Signature"),
    "presigned-read",
    `signed GET -> ${presigned.status}`
  );

  const unsignedUrl = `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${key}`;
  const unsigned = await fetch(unsignedUrl);
  record(
    !unsigned.ok,
    "unsigned-read-denied",
    `unsigned GET -> ${unsigned.status}`
  );

  await storage.file(key).delete();
  record(true, "delete", `deleted ${key}`);

  await expectRefused("read-after-delete", () => storage.file(key).stat());
} finally {
  // Never leave an object behind on a mid-run failure — the bucket is the
  // real production one.
  await storage
    .file(key)
    .delete()
    .catch(() => undefined);
}

// The credential-denial case the acceptance criteria name: same endpoint, same
// bucket, deliberately wrong secret.
const wrongCredentials = new S3Client({
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: "deliberately-wrong-secret-access-key",
  endpoint: process.env.S3_ENDPOINT,
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
});
await expectRefused("bad-credentials-denied", () =>
  wrongCredentials.file(`smoke/${crypto.randomUUID()}.bin`).write("nope")
);

console.log();
if (failures) {
  console.log(`FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log("OK: all checks passed");
