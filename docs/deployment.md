# Deployment

Two targets: a local Docker Compose stack and a single-project GCP deployment.
`docker-compose.yml` is the source of truth for local services and ports;
`infrastructure/terraform` and `infrastructure/scripts` are for GCP.

## Prerequisites

- Bun 1.3 or newer
- pnpm 12 or newer
- Docker Compose for the full stack and integration tests

## Local stack

Copy the checked-in environment examples without committing the resulting
`.env` files, then install dependencies:

```bash
pnpm install --frozen-lockfile
```

Apply generated migrations for every atom before starting a local stack:

```bash
pnpm --filter @townops/auth-atom db:migrate
pnpm --filter @townops/alert-atom db:migrate
pnpm --filter @townops/appointment-atom db:migrate
pnpm --filter @townops/assignment-atom db:migrate
pnpm --filter @townops/case-atom db:migrate
pnpm --filter @townops/contractor-atom db:migrate
pnpm --filter @townops/metrics-atom db:migrate
pnpm --filter @townops/proof-atom db:migrate
pnpm --filter @townops/resident-atom db:migrate
```

Start the full local topology:

```bash
docker compose up --build
```

The Gateway has **no** `/health` route — it exposes only `/api/*`, and a
request to `/health` is a 404, not a health signal. The nine atoms and the
three frontend servers each serve `/health`; check one of those instead, e.g.
`http://localhost:5005/health` for the Case atom. Temporal UI is
`http://localhost:8080`. A Worker has no public HTTP port at all.

## Configuration boundaries

Gateway connects to Temporal, validates JWTs through Auth JWKS, proxies public
`/api/auth/*`, and receives `WORKER_SERVICE_TOKEN` for trusted atom access.
Worker receives the same token and atom URLs for its Activities. Internal atom
routes require that token. On Cloud Run the atoms are additionally IAM-private,
and the caller's ID token travels in `X-Serverless-Authorization` rather than
`Authorization`, because `workerAuth` already owns `Authorization`.

All three frontend applications use `VITE_GATEWAY_URL` (locally
`http://localhost:6010`) for browser API calls. Do not configure atom or
retired-service URLs in a frontend.

## Operating failures

Temporal UI shows Workflow Task and replay failures. Gateway returns
`504 WORKFLOW_UPDATE_PENDING` when an accepted Update outlives its wait,
`503 TEMPORAL_UNAVAILABLE` when Temporal cannot be reached, and
`500 WORKFLOW_UPDATE_FAILED` for other Update failures. A pending Update is
not a lost write; retry the request with its idempotency key.

## GCP deployment

One project, one region, direct VPC egress — no Serverless VPC Access
connector and no Cloud NAT, both of which bill hourly for what subnets give
away free.

| Layer         | Shape                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| Temporal      | Self-hosted on a Container-Optimized OS VM, **no public IP**, reachable via IAP |
| Gateway       | Cloud Run, public ingress, the only public API surface                          |
| Worker        | Cloud Run **Worker Pool**, 1 always-on instance, no HTTP listener               |
| 9 atoms       | Cloud Run, IAM-private — invokable only by the Gateway and Worker identities    |
| 3 frontends   | Cloud Run, public, static files plus a runtime-env injecting server             |
| Persistence   | 2 Cloud SQL PostgreSQL instances, **private IP only**                           |
| Proof storage | Cloudflare R2, private objects served as presigned URLs                         |

### Project and region constants

| Constant        | Value                                 |
| --------------- | ------------------------------------- |
| Project ID      | `seraphic-cocoa-505015-s9`            |
| Project number  | `850982781459`                        |
| Region          | `asia-southeast1`                     |
| Zone            | `asia-southeast1-b`                   |
| Billing account | `0126F6-2E7563-2D49AB` (currency SGD) |

**Never rely on ambient `gcloud config`.** It points at an unrelated project.
Every script and the Terraform provider pin `--project` explicitly, and
`gcloud billing budgets` additionally needs `--billing-project`, because it
resolves its quota project from ambient config rather than from
`--billing-account`.

### Apply order

**Routine deploys are `.github/workflows/deploy.yml` — see [The deploy
pipeline](#the-deploy-pipeline).** The order below is the one-time bootstrap
that has to happen before the pipeline can run at all, plus the by-hand
equivalent for anyone applying without CI.

Each step assumes the previous one succeeded. Everything is idempotent and
re-runnable; anything that already exists is reported `SKIP`, never recreated.

One-time, by an operator, from a workstation:

```
1  infrastructure/scripts/bootstrap.sh            # state bucket, budget, 7 secrets
2  terraform apply                                # network, Cloud SQL, registry, SAs, IAM, WIF
3  infrastructure/scripts/mirror-images.sh        # needs the registry from step 2
4  infrastructure/scripts/bootstrap-databases.sh  # SQL users + 9 db-url-* secrets
5  terraform apply                                # Temporal VM
6  infrastructure/scripts/bootstrap-databases.sh  # again — extensions, over IAP via the VM
```

Then every deploy, by the pipeline — or by hand with the same commands:

```
7   docker build/push 13 images tagged <git-sha>
8   terraform apply -var image_tag=<git-sha>                    # Cloud Run — pass 1
9   terraform apply -var image_tag=<git-sha> -var gateway_url=… # pass 2, see below
10  infrastructure/scripts/promote-worker-version.sh <git-sha>  # REQUIRED — see below
11  verification, below
```

`bootstrap-databases.sh` runs twice on purpose: pass one creates the SQL users
and the 9 `db-url-<atom>` secrets, pass two installs the Postgres extensions
and needs the Temporal VM as an IAP jump host.

`image_tag` is **not** in `terraform.auto.tfvars` and must not be put back.
The deleted `build-push.sh` used to rewrite that tracked file in place on every
build; the tag now arrives only as `-var image_tag=<git-sha>`.

The variable is **required and has no default**, so omitting the flag is a hard
error (`No value for required variable`) rather than a silent deploy. That
matters: while it still defaulted to `"unset"`, one bare `terraform apply` took
the deployment down — it rewrote all 9 atoms and 3 frontends to a tag that does
not exist in Artifact Registry, leaving 12 services `Ready=False`. Recovery is
`terraform apply -var image_tag=<a tag that exists>`. `teardown.sh` passes a
throwaway value, because a destroy does not care what the tag was.

**Step 10 is not optional, and skipping it looks like a network fault.** The
Worker Pool sets `BUILD_ID` to the image tag, making it a _versioned_ Worker
under the `townops-orchestration` Worker Deployment; a versioned Worker does
not poll the unversioned task queue, and Temporal routes tasks only to a
Deployment's **current version**, which nothing sets automatically. Until it is
promoted, every Workflow sits at `HistoryLength 2` with an empty
`AssignedBuildId` and no Activity runs, while the Worker's own logs report
`Worker state changed → RUNNING`. The script reads the version back after
setting it, because `set-current-version` succeeds against a build no Worker
registered. **Re-run it after every apply that changes `image_tag`.**

### The deploy pipeline

`.github/workflows/deploy.yml`. Triggers on `workflow_dispatch` and on push to
`main`; `dev` never deploys. One job, in order: build the workspace, run the two
guards below, authenticate, push 13 images, plan, apply twice, promote the
Worker version, then `verify-workflow.sh` and `smoke-r2.ts`.

Separate from `ci.yml` on purpose — quality gates and deployment fail for
different reasons and want different triggers. `concurrency.cancel-in-progress`
is **false**: an interrupted `terraform apply` leaves state to reconcile by hand.

**Authentication is keyless.** `wif.tf` defines a Workload Identity pool and an
OIDC provider whose `attribute_condition` admits only
`assertion.repository == 'zek01svg/town-ops'`, and binds
`roles/iam.workloadIdentityUser` to a `principalSet` scoped to the same
repository — the check is made twice, at admission and at binding. There is no
service account key anywhere. The provider path and the deploy SA's email sit in
the workflow as plain `env:` values rather than repository secrets, because both
are useless without an OIDC token from that repository.

The branch restriction deliberately does **not** live in the trust condition:
pinning `assertion.ref` there would break `workflow_dispatch` from a scratch
branch, which is how the pipeline's negative test is run. The gate is the `on:`
trigger plus the `trial` environment.

**`wif.tf` must be applied locally by an operator before the first pipeline
run** — a pipeline cannot create the identity it authenticates as. After that
apply, check `terraform output -raw workload_identity_provider` against
`WIF_PROVIDER` in the workflow: it is a hardcoded literal there, because
reading it from state would need the very credentials it grants.

The `trial` environment carries no required reviewer today. Adding one would
also gate `workflow_dispatch` runs, which is how the pipeline's negative test
is exercised — expect an approval click on those too.

#### The deploy service account's scope

`townops-deploy` holds roughly project-editor, and that is a real cost rather
than an oversight. Terraform here manages VPC, Cloud SQL, Cloud Run, 13 service
accounts, project IAM bindings and an API key, so the role set is wide by
construction. Three entries are genuine escalation points and are commented as
such in `wif.tf`: `roles/iam.serviceAccountAdmin` (creating identities),
`roles/resourcemanager.projectIamAdmin` (granting project IAM is in principle
the ability to grant anything), and `roles/iap.admin`.

Two narrowings are deliberate and worth keeping:

- **Secret Manager access is a custom role**, `townopsSecretIamAdmin`, carrying
  only `secrets.get`/`getIamPolicy`/`setIamPolicy`. `secrets.tf` only ever
  grants access and never reads a value, so the predefined
  `roles/secretmanager.admin` — which would hand CI `versions.access` on all 16
  secrets — is not used. The two exceptions are `r2-access-key-id` and
  `r2-secret-access-key`, granted per-secret for `smoke-r2.ts`.
- **`roles/iam.serviceAccountUser` is bound per-account** on the 13 runtime SAs,
  not project-wide, and `roles/storage.admin` is bound on the state bucket only.

What actually contains the blast radius is the trust condition, not the role
list: only an OIDC token from this repository can assume the identity.

#### Absorbed checks

`build-push.sh` was deleted, but the two guards it carried each caught a real
production-only break and both are proven falsifiable, so they run as pipeline
steps before anything is pushed or applied:

| Guard                                                              | Catches                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| No `NODE_ENV:"development"` in any of the 12 bundles               | a build script that lost `--production`                               |
| `node --experimental-strip-types` imports `orchestration-contract` | a relative import missing its `.ts`, which only dies in the container |

A third, three-line guard replaces `cost-estimate.sh`: the rendered plan JSON
must contain no `google_compute_router_nat` and no
`google_vpc_access_connector`. The plan is written to a file before grepping,
deliberately — piping `terraform show` straight into the test would make a
_failed_ show read as "found nothing" and report PASS on a harness that never
inspected a plan.

`verify-network.sh` is **not** in the pipeline. One of its controls needs an IAP
tunnel, which would mean granting the deploy identity
`roles/iap.tunnelResourceAccessor`, and it spawns Cloud Run jobs plus a probe
VM. It stays an operator script, run on infrastructure changes.

#### Promotion from a runner

`promote-worker-version.sh` has to reach Temporal on `10.0.0.4:7233`, which is
admitted only from `10.0.1.0/24`, and a GitHub-hosted runner is nowhere near
that. It runs the Temporal CLI as a **throwaway Cloud Run job on
`townops-run-temporal-subnet`** — the same trick `verify-network.sh` uses for
its probes — which reaches the port natively. The rejected alternative,
`gcloud compute ssh --tunnel-through-iap`, additionally needs instance-metadata
write and leaves the caller's public key in `ssh-keys`, which dirties every
later plan.

Two things about that job, both learned the hard way:

- The image is Alpine-based and has **no `bash`**. Use `--command=sh`; the only
  feedback otherwise is `Application exec likely failed` in the job logs.
- The **read-back runs inside the job**, so the job's exit code carries the
  verdict. `set-current-version` succeeds against a build no Worker ever
  registered, and that failure would otherwise surface only as Workflows that
  never progress.

### What bootstrap.sh creates

- **State bucket** `gs://townops-tf-state-850982781459` — uniform bucket-level
  access, public access prevention, object versioning. Created with `gcloud`,
  because a module cannot use the backend it is still creating.
- **Budget** `townops-trial` — SGD 120/month, alerting at 50/90/100% actual
  plus 100% forecast. Live before the first billable resource, and **the** cost
  control in the path. A 310-line `cost-estimate.sh` that priced a plan against
  the live Billing Catalog was deleted along with `preflight.sh`: nothing called
  it, and on a steady-state plan it priced nothing. Its one durable assertion —
  that no `google_compute_router_nat` or `google_vpc_access_connector` ever
  enters the plan, both of which bill hourly — survives as a three-line guard in
  the pipeline.
- **7 secrets.** Four generated with `openssl` and piped straight into
  `gcloud secrets create --data-file=-`, never echoed (`worker-service-token`,
  `better-auth-secret`, `temporal-db-password`, `atoms-db-password`; the DB
  passwords are hex, so URL-safe inside `postgres://user:pass@host`). Three
  pasted from an env var of the same name (`resend-api-key`,
  `r2-access-key-id`, `r2-secret-access-key`) — a missing one is `SKIP`, not
  `FAIL`, and the script prints the command to add it later.

`bootstrap-databases.sh` adds the 9 `db-url-<atom>` secrets, 16 in total. There
is deliberately no `google-maps-api-key` secret: the Maps key is a Terraform
`google_apikeys_key` restricted to the Maps JavaScript API and the three
frontend `run.app` referrers, and it ships publicly in `window.__env`.

### The two-pass apply

`run.app` URLs are **opaque** — a service comes back as e.g.
`https://gateway-3awkz54whq-as.a.run.app`, not a computable
`<name>-<project-number>.<region>.run.app` — so no URL can be predicted before
apply. Most wiring resolves through `google_cloud_run_v2_service.<x>.uri` in
one pass; two edges cannot, because they close a cycle:

- the frontends need the Gateway's URL, while the Gateway needs theirs for CORS
- the auth atom needs the Gateway's URL as `BETTER_AUTH_URL`, while the Gateway
  needs the auth atom's URL

Referencing `.uri` there makes Terraform reject the graph outright, so both
arrive as plain string variables set on a second apply:

```bash
terraform apply                              # pass 1: both empty
terraform output -raw gateway_url            # -> gateway_url in terraform.auto.tfvars
terraform output -json frontend_urls         # -> frontend_urls in terraform.auto.tfvars
terraform apply                              # pass 2: wiring closed
```

Empty is a working pass-1 value everywhere it lands: `BETTER_AUTH_URL` is
`z.string()` and not `.url()`, the Gateway falls back to its localhost CORS
default on an empty `GATEWAY_ALLOWED_ORIGINS`, and the frontend server omits an
empty `VITE_GATEWAY_URL` from `window.__env`. A from-scratch rebuild must reset
both variables to empty before its pass 1.

### Secrets never touch Terraform state

Terraform **never creates a secret at all.** Scripts create the container and
the version with `gcloud`; Terraform only grants
`google_secret_manager_secret_iam_member`, whose `secret_id` is a plain string.
Banned outright, because all of them persist plaintext into
`terraform.tfstate`: `random_password`, `tls_private_key`,
`tls_self_signed_cert`, `google_secret_manager_secret_version`, and
`google_sql_user` — so Cloud SQL users are created through the Admin REST API
instead. That is why secrets survive every destroy, and why `teardown.sh`
deletes them by name as a separate step.

Two gating bools in `secrets.tf` — `db_url_secrets_exist` and
`pasted_secrets_exist` — exist because Secret Manager's `setIamPolicy` 404s
against a secret that does not exist yet. Both are `true` today. On a
**from-scratch rebuild**, set both to `false` for the first apply, run the two
bootstrap scripts, then flip them back.

### Manual Cloudflare prerequisites

Not automatable from `gcloud` or Terraform, and no Cloudflare provider is used
because `cloudflare_api_token.value` would persist plaintext into state. Do
these in the dashboard before the Cloud Run apply:

1. Create an R2 bucket named `townops-proofs`, **Standard** storage class (not
   Infrequent Access), APAC location hint.
2. Create an **Object Read & Write** API token scoped to that bucket only —
   this yields `r2-access-key-id` and `r2-secret-access-key`.
3. **Do NOT enable the bucket's `r2.dev` public read.** Objects stay private:
   the `proof_items` row stores only the object path, and `proofDto()` signs it
   at read time via `storage.presign()`. A public bucket would make every proof
   photo readable forever by anyone holding the URL, which is why
   `S3_PUBLIC_URL` no longer exists.
4. Note the R2 account ID — it forms `S3_ENDPOINT`,
   `https://<account-id>.r2.cloudflarestorage.com`. It is **not** a secret and
   lives in `terraform.auto.tfvars` as `r2_account_id`, useless without the
   credentials that do live in Secret Manager.

The R2 Standard free tier (10 GB-month, 1M Class A, 10M Class B, zero egress)
covers a few hundred proof photos: expected cost SGD 0.00.

### Verification

| Script                                      | Proves                                                                |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `infrastructure/scripts/verify-network.sh`  | Network and IAM isolation, each denial with a paired control          |
| `apps/atoms/proof/scripts/smoke-r2.ts`      | R2 upload / metadata read / read / delete / denial, production client |
| `infrastructure/scripts/verify-workflow.sh` | Gateway → Temporal → Worker → atoms, one real request end to end      |

#### verify-network.sh

Every denial is paired with a control that goes green under the same probe,
because an assertion that cannot fail proves nothing:

| Check                                          | Expected       | Paired control                                     |
| ---------------------------------------------- | -------------- | -------------------------------------------------- |
| atom subnet → `<vm>:7233`                      | denied         | Gateway **and Worker** identities are both allowed |
| atom subnet → `<vm>:8080` (Web UI)             | denied         | IAP tunnel → `8080` is allowed                     |
| Gateway subnet → `<vm>:8080`                   | denied         | same                                               |
| VM on `townops-subnet` → `<vm>:7233`           | denied         | Gateway subnet → `7233` is allowed                 |
| anonymous → atom                               | 403            | Gateway identity → atom is 200                     |
| unrelated identity (`townops-frontend`) → atom | 403            | same                                               |
| VM has a public IP                             | **structural** | — see below                                        |

Gateway and Worker are probed as two identities rather than one being inferred
from the shared subnet, and an identity probe aborts on an empty ID token
rather than sending an unauthenticated request that would collect a 403 and
pass for the wrong reason.

The TCP probes run as **real Cloud Run jobs on the real subnets under the real
service accounts**, not as target-tag assertions: under direct VPC egress a
packet's identity _is_ its subnet address, because `source_service_accounts`
applies only to GCE instances. Splitting Gateway+Worker (`10.0.1.0/24`) from
the 9 atoms (`10.0.2.0/24`) is the only reason `7233` can be restricted at all.
`vm-has-no-public-ip` is the one **structural** check — it asserts the instance
has no `accessConfigs`, and there is no address to send a packet to.

**The VPC firewall is not the only firewall.** Container-Optimized OS ships its
own host firewall, and a stock image has `-P INPUT DROP` with ACCEPT rules for
established connections, loopback, ICMP, and `tcp/22` — nothing else. Both
Temporal ports run under `--network host`, so every packet crosses that INPUT
chain, and 7233 and 8080 are dropped at the VM no matter what the VPC permits.
**The symptom is a connection timeout, indistinguishable from a VPC firewall
denial.** `temporal-hostfw.service` in the cloud-init opens the two ports;
source scoping stays in `firewall.tf`.

#### What verify-workflow.sh does and does not prove

It **does** prove transport and orchestration: sign-up through the Gateway's
`/api/auth/*` proxy (which needs a minted ID token against the IAM-private auth
atom), a JWT from the auth atom's JWKS, a `CaseWorkflow` started on the private
Temporal VM, activities executed by the Worker Pool, and the Case persisted in
and read back from the case atom.

It does **not** prove browser cookie semantics — `curl` ignores `SameSite`
entirely. The session cookie is set on the Gateway's `run.app` host while the
browser's origin is a frontend's `run.app` host, and `run.app` is on the Public
Suffix List, making those cross-**site**, not merely cross-origin. Better Auth
defaults to `SameSite=Lax`, which no browser would attach to that request, so
`apps/atoms/auth/src/auth.ts` sets `sameSite: "none", secure: true` whenever
`BETTER_AUTH_URL` is https. Local dev stays on `Lax`, where every localhost
port is the same site and `None` would be rejected for lacking `Secure`.

R2 is **not** on the workflow path: reaching a `proof_items` row needs a
CONTRACTOR account with an accepted assignment, and `role`/`contractorId` are
`input: false` in the auth schema, so no public API can get a script there.

#### smoke-r2.ts

Proves R2 directly. It imports `apps/atoms/proof/src/storage.ts` rather than
rebuilding an equivalent, and runs under **Bun, never Node** — production uses
`import { S3Client } from "bun"` and there is no `@aws-sdk/client-s3` here.

```bash
export S3_ENDPOINT="$(terraform -chdir=infrastructure/terraform output -raw r2_endpoint)"
export S3_BUCKET=townops-proofs S3_REGION=auto
export S3_ACCESS_KEY_ID="$(gcloud secrets versions access latest --secret=r2-access-key-id --project=seraphic-cocoa-505015-s9)"
export S3_SECRET_ACCESS_KEY="$(gcloud secrets versions access latest --secret=r2-secret-access-key --project=seraphic-cocoa-505015-s9)"
bun apps/atoms/proof/scripts/smoke-r2.ts
```

### Rollback

- **An application deploy** is a Cloud Run revision switch:
  `gcloud run services update-traffic <svc> --to-revisions=<prev>=100`. Seconds,
  no Terraform.
- **Infrastructure** is `terraform apply` at the previous commit; targeted
  removal is `terraform destroy -target`.
- **The VM is stateless** — all state is in Cloud SQL — and re-creates from
  cloud-init.
- **Secrets survive every destroy**, because Terraform never owned their values.

### Teardown

`teardown.sh --dry-run` runs `terraform plan -destroy` and lists the secrets it
would remove; `--confirm` destroys for real; neither flag prints usage and
exits 1. One `destroy` is enough — the deployment is a single flat state. It
then deletes all 16 secrets by name.

Deliberately left behind: the `gs://townops-tf-state-850982781459` state bucket
and the `townops-trial` budget. Finish by hand in Cloudflare — delete the
`townops-proofs` bucket and its objects, revoke the scoped R2 token, and revoke
the Resend API key. To rebuild from scratch afterwards, reset `gateway_url` and
`frontend_urls` to empty, set both `secrets.tf` bools to `false`, and start
again at step 1.

### Google OAuth

Off by design. `apps/atoms/auth/src/auth.ts` builds `socialProviders` only when
both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, and both are
`.optional()`; unset means email/password only and no Console step. To enable
it later, set both vars and add the Gateway's `run.app` URL to the OAuth
client's authorized redirect URIs.

### Known gaps

- **Temporal mTLS is unmet.** Cloud Run → `<vm-ip>:7233` is unencrypted inside
  the VPC; the protection is private networking, a source-scoped firewall, and
  no public IP. Tracked as PRS-211.
- Browser cookie semantics are unverified against a real browser (above). Both
  branches are covered by unit tests
  (`apps/atoms/auth/tests/unit/cross-site-cookies.test.ts` and its localhost
  control in `index.test.ts`), and `verify-workflow.sh` asserts the Gateway's
  CORS preflight, but nobody has driven a browser through a deployed login.
