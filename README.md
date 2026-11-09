# Files API v6

Standalone authenticated S3 upload signing for Uppy 6.0, plus durable attachment downloads. The service has no database dependency and never sends AWS credentials to browsers.

## HTTP contract

The base URL is `https://api.topcoder-dev.com/v6/uploads/files` in dev and `https://api.topcoder.com/v6/uploads/files` in production.

| Method | Path relative to base | Purpose |
| --- | --- | --- |
| GET | `/health` | Container and load-balancer health |
| POST | `/sessions` | Create a member-owned upload grant and server-selected S3 destination |
| POST | `/sign` | Sign Uppy's single-part or multipart S3 operation |
| GET | `/:token` | Resolve a durable read capability to a short-lived S3 download URL |

Session inputs are `purpose`, `filename`, `contentType`, `size`, and optional `contextId`. Supported purposes are `submission`, `cv`, `engagement`, `review`, `forum`, `project`, and `showcase`. ZIP submissions are limited to 500 MiB, PDF/DOCX CVs to 8 MiB, forum attachments to 25 MiB, and other attachments to 500 MiB. Multipart uploads use 10 MiB parts. Upload grants expire after 24 hours and presigned operations after 15 minutes.

Write endpoints require a verified member JWT using the shared Topcoder verifier. Machine tokens cannot create or sign uploads. The API chooses bucket/key destinations; a caller cannot request arbitrary reads, writes, or deletes. Submission URLs remain canonical S3 URLs for the existing submission scan pipeline. Showcase files retain their signed-CDN flow. Other download capabilities allow anyone holding the link to read that file, matching the previous attachment-link behavior; keep these links private when the containing resource is private.

## Runtime configuration

ECS injects runtime values from Parameter Store. The service's parameters live under `/config/files-api-v6/appvar/`. AWS secrets, environment deployment manifests, IAM policies, ECS/network definitions, and provisioning scripts must stay outside Git and Docker build contexts.

- `AUTH_SECRET`, `VALID_ISSUERS`, `JWT_AUDIENCE`, `AUTH0_AUDIENCE`: shared JWT settings. Runtime identity denylist settings are honored by the shared verifier.
- `SUBMISSION_DMZ_S3_BUCKET`: existing submission destination.
- `UPLOAD_ATTACHMENT_BUCKET`, `UPLOAD_FORUM_BUCKET`, `UPLOAD_PROJECT_BUCKET`, `UPLOAD_SHOWCASE_BUCKET`: existing attachment destinations.
- `UPLOAD_SHOWCASE_CDN_URL`: canonical showcase media base.
- `UPLOAD_PUBLIC_API_URL`: this service's public base URL above.
- `UPLOAD_SIGNING_SECRET`: persistent random signing secret, at least 32 bytes. Preserve the previous upload service's secret when migrating; rotating it invalidates existing file links.
- `CORS_ORIGINS`: comma-separated browser origins.
- `AWS_REGION` and optional `PORT` (default 3000).

The infrastructure migration rewrites legacy attachment URLs to this service and preserves their signing secret. Application routes contain only the new `/v6/uploads/files` contract. S3 buckets remain private, and browser upload origins require the existing S3 CORS rules.

## Development and deployment

Use Node 26.12.1 or newer, `npm ci`, `npm run lint`, `npm test`, and `npm run build`. Supply runtime settings through your local environment or a private Docker env file. Never commit real values.

The Nest runtime and test libraries are pinned together at 12.4.2. Production builds use TypeScript 7.0.2 (`typescript-native`, an npm alias for the stable `typescript` package). Nest CLI 12.0.12, schematics 12.0.13, and ESLint currently require the older compiler API, so TypeScript 6.0.3 is retained only for that tooling. `npm run build` explicitly invokes the TypeScript 7 compiler; `npm run start:dev` uses the Nest CLI for local watch mode. This coexistence avoids unsupported peer overrides while using the latest stable compiler for releases.

CircleCI builds/tests the image without AWS credentials. `develop` deploys to dev; `master` deploys to production after the standard approval job. Both use the pinned `tc-deploy-scripts` suite and repository/project/branch-bound OIDC. The ECS cluster, service, task family, container, and image repository are named `files-api-v6`.

Protected deployment contexts supply `FILES_DEPLOY_MANIFEST`; it is written only to a temporary file during deployment. No AWS-specific manifests are committed. Deploy roles can publish scanned images and update this service, but cannot provision infrastructure, read runtime secrets, or assume other roles. Runtime task/execution roles and infrastructure must be provisioned separately before enabling deployment.
