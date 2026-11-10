# Files API v6

Standalone authenticated S3 upload signing for Uppy 6.0, plus durable attachment downloads. DynamoDB provides shared upload reservations and request counters. The service never sends AWS credentials to browsers.

## HTTP contract

The base URL is `https://api.topcoder-dev.com/v6/uploads/files` in dev and `https://api.topcoder.com/v6/uploads/files` in production.

| Method | Path relative to base | Purpose |
| --- | --- | --- |
| GET | `/health` | Container and load-balancer health |
| POST | `/sessions` | Create a member-owned upload grant and server-selected S3 destination |
| POST | `/sign` | Sign Uppy's single-part or multipart S3 operation |
| POST | `/multipart/:token` | Idempotently allocate a multipart upload using an upload capability |
| GET | `/:token` | Resolve a durable read capability to a short-lived S3 download URL |

Session inputs are `purpose`, `filename`, `contentType`, `size`, and optional `contextId`. Supported purposes are `submission`, `cv`, `engagement`, `review`, `forum`, `project`, `showcase`, and `support`. ZIP submissions are limited to 500 MiB, PDF/DOCX CVs to 8 MiB, forum attachments to 25 MiB, Support attachments to 2 MiB, and other attachments to 500 MiB. Support preserves its filename-extension/MIME allowlist (documents, archives, text, and supported images); HTML, SVG, and mismatched extension/MIME pairs are rejected before quota is reserved. Support files use the shared attachment bucket under `uppy/support/` and durable Files API links. Existing Filestack links are unaffected. Multipart uploads use 10 MiB parts. Upload grants expire after 24 hours and presigned S3 operations after 5 minutes.

Session creation and signing require an authenticated member JWT using the shared Topcoder verifier. Multipart allocation uses the signed, expiring upload capability returned to that member and returns the S3 XML expected by Uppy. Machine tokens cannot create or sign uploads. The API chooses bucket/key destinations; a caller cannot request arbitrary reads, writes, or deletes. Submission URLs remain canonical S3 URLs for the existing submission scan pipeline. Showcase files retain their signed-CDN flow. Other download capabilities allow anyone holding the link to read that file, matching the previous attachment-link behavior; keep these links private when the containing resource is private.

## Upload controls

Each environment reserves upload capacity atomically before issuing a grant. Defaults are 100 files and 5 GiB per member per UTC day, and 100 GiB plus 10,000 files across the service per UTC day. Reservations count failed or canceled uploads too; they are not refunded. The declared full file size is reserved, and signed content lengths and part numbers bound bytes written. Counters are shared across ECS tasks; an unavailable counter store fails closed with HTTP 503. Limits return HTTP 429 with `Retry-After`.

Each member can create 20 sessions per minute and make 300 signing requests per minute. Multipart allocation has a separate 300-per-minute member counter; each attachment download capability allows 300 resolutions per minute. An upload grant is bound to either single-part mode or one multipart upload ID. Replaying multipart creation returns the same ID; ambiguous allocation failures cannot create additional uploads. Grants issued before shared reservations were introduced must be recreated; existing attachment read links still work.

API Gateway route throttles and a bounded process request budget protect application work before body parsing and authentication. Infrastructure also removes abandoned multipart uploads after one day, restricted to upload prefixes. These controls bound new upload reservations, not total historical storage or all request costs. Already issued S3 URLs remain reusable until they expire; S3 traffic bypasses the API's request counters. Gateway throttling is best effort, and these limits do not guarantee availability during every denial-of-service attack.

## Runtime configuration

ECS injects runtime values from Parameter Store. The service's parameters live under `/config/files-api-v6/appvar/`. AWS secrets, environment deployment manifests, IAM policies, ECS/network definitions, and provisioning scripts must stay outside Git and Docker build contexts.

- `AUTH_SECRET`, `VALID_ISSUERS`, `JWT_AUDIENCE`, `AUTH0_AUDIENCE`: shared JWT settings. Runtime identity denylist settings are honored by the shared verifier.
- `SUBMISSION_DMZ_S3_BUCKET`: existing submission destination.
- `UPLOAD_ATTACHMENT_BUCKET`, `UPLOAD_FORUM_BUCKET`, `UPLOAD_PROJECT_BUCKET`, `UPLOAD_SHOWCASE_BUCKET`: existing attachment destinations.
- `UPLOAD_SHOWCASE_CDN_URL`: canonical showcase media base.
- `UPLOAD_PUBLIC_API_URL`: this service's public base URL above.
- `UPLOAD_SIGNING_SECRET`: persistent random signing secret, at least 32 bytes. Preserve the previous upload service's secret when migrating; rotating it invalidates existing file links.
- `CORS_ORIGINS`: comma-separated browser origins.
- `UPLOAD_QUOTA_TABLE`: required shared DynamoDB table, partition key `pk` (string), TTL attribute `ttl`.
- `UPLOAD_MAX_FILES_PER_DAY` (100), `UPLOAD_MAX_BYTES_PER_DAY` (5368709120): member daily limits.
- `UPLOAD_MAX_GLOBAL_FILES_PER_DAY` (10000), `UPLOAD_MAX_GLOBAL_BYTES_PER_DAY` (107374182400): environment daily limits.
- `UPLOAD_MAX_SESSIONS_PER_MINUTE` (20), `UPLOAD_MAX_SIGN_REQUESTS_PER_MINUTE` (300), `UPLOAD_MAX_DOWNLOADS_PER_MINUTE` (300): shared request limits.
- `UPLOAD_REQUESTS_PER_SECOND` (50), `UPLOAD_REQUEST_BURST` (100): process request budget; health probes are exempt.
- `AWS_REGION` and optional `PORT` (default 3000).

Limits can be changed in Parameter Store without a code change; restart ECS tasks to load the new values.

The infrastructure migration rewrites legacy attachment URLs to this service and preserves their signing secret. Application routes contain only the new `/v6/uploads/files` contract. S3 buckets remain private, and browser upload origins require the existing S3 CORS rules.

## Development and deployment

Use Node 26.12.1 or newer, `npm ci`, `npm run lint`, `npm test`, and `npm run build`. Supply runtime settings through your local environment or a private Docker env file. Never commit real values.

The Nest runtime and test libraries are pinned together at 12.4.2. Production builds use TypeScript 7.0.2 (`typescript-native`, an npm alias for the stable `typescript` package). Nest CLI 12.0.12, schematics 12.0.13, and ESLint currently require the older compiler API, so TypeScript 6.0.3 is retained only for that tooling. `npm run build` explicitly invokes the TypeScript 7 compiler; `npm run start:dev` uses the Nest CLI for local watch mode. This coexistence avoids unsupported peer overrides while using the latest stable compiler for releases.

CircleCI builds/tests the image without AWS credentials. `develop` deploys to dev; `master` deploys to production after the standard approval job. Both use the pinned `tc-deploy-scripts` suite and repository/project/branch-bound OIDC. The ECS cluster, service, task family, container, and image repository are named `files-api-v6`.

Protected deployment contexts supply `FILES_DEPLOY_MANIFEST`; it is written only to a temporary file during deployment. No AWS-specific manifests are committed. Deploy roles can publish scanned images and update this service, but cannot provision infrastructure, read runtime secrets, or assume other roles. Runtime task/execution roles and infrastructure must be provisioned separately before enabling deployment.

### Temporary email-claim compatibility

The shared verifier is pinned to `v4.0.0-rc.2` (commit `58de37670180e183e8378c3d203df0112a0414f6`) until production token issuance includes the verified-email claim. Email verification claims are temporarily not enforced. Signature, issuer, audience, expiry, member identity, and configured identity denylists remain enforced. After token issuance is deployed and existing sessions are handled, restore the enforcing verifier revision (`c2df92b2227089909ab6e229df0ec6b658bb431a` or its reviewed successor), update the lockfile, and restore missing/false-claim rejection tests before deploying.
