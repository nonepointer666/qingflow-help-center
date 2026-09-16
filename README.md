# Qingflow Help Center

This repository implements a self-hosted help center based on:

- `Outline` as the production content source
- `GitHub` for application code, stable route metadata, and the legacy snapshot
- `Docusaurus` for the documentation site and information architecture
- `Typesense` for self-hosted search

The product direction references the good parts of Mintlify, but keeps the full delivery stack under our control.

## What is included in Phase 1

- Branded Docusaurus site shell
- Help center content structure and sample docs
- Version-ready docs-as-code workflow
- Search page prepared for Typesense
- Search record generation script
- GitHub Actions CI workflow

## Local development

```bash
npm install
npm start
```

`npm start` requires `OUTLINE_API_TOKEN`, synchronizes the configured Outline
collection, and then starts Docusaurus with the generated content. To work
against the retained legacy snapshot without contacting Outline, run:

```bash
npm run start:legacy
```

## Build

```bash
npm run build
```

This will:

- synchronize the `售后知识库(公开)` collection from Outline
- build the Docusaurus site into `build/`
- generate `.tmp/search-records.json` for Typesense indexing

Use `npm run build:legacy` for an offline build from `docs/migrated`.

## Outline content sync

The production source URL is `https://outline.qingflow.com`. Configure a
read-only `OUTLINE_API_TOKEN` in the environment and run:

```bash
npm run content:sync
```

The sync uses `POST /api/collections.list`, reads the Outline document tree and
Markdown content, and writes disposable output to `docs/generated/` and
`sidebars.generated.ts`. These generated files are intentionally ignored by
Git. Images, videos, and attachments are not downloaded; their references are
kept as absolute Outline URLs. The sync process explicitly disables inherited
HTTP, HTTPS, and SOCKS proxy environment settings and connects to Outline
directly.

Every current document uses the normalized Outline `urlId` as its canonical
route (`/docs/outline/<urlId>`). Titles and directory moves therefore update the
generated sidebar and breadcrumbs without changing the document URL. The
versioned `data/outline-route-map.json` contains only compatibility records for
URLs that were already published before this routing model; new Outline
documents are never added to it. Active records redirect directly to a current
`urlId`, explicit redirects point to a replacement, and deleted records retain
a permanent `noindex` retirement page. If an active compatibility target
disappears, synchronization fails before replacing the previous generated
snapshot so the record must be explicitly changed to `redirect` or `deleted`.

Navigation hierarchy and page content are classified independently during
synchronization. Pages with meaningful body content are emitted as `content`
or `hybrid`; parents containing only links to descendants become `directory`
pages; blank leaves become `empty` pages. Directory and hybrid pages render
their direct children as a chapter index, while only `content` and `hybrid`
pages are included in Typesense and the generated AI document indexes. The
classification summary is written to `.tmp/outline-sync-report.json`.

Normal synchronization does not read `docs/migrated/` or `sidebars.ts`.
`sidebars.generated.ts`, document navigation paths, and search breadcrumbs are
always derived from the current Outline tree. Never put an API token in this
repository or in a command committed to shell history.

Container builds also require the token as a BuildKit secret so that it is not
stored in an image layer:

```bash
docker build --secret id=outline_api_token,env=OUTLINE_API_TOKEN .
```

## GitHub pull request validation

`.github/workflows/docs-ci.yml` validates pull requests with the retained legacy
snapshot on a GitHub-hosted runner. It does not receive production secrets,
synchronize Outline, publish Typesense records, or deploy the site. Production
build and deployment are owned by Jenkins as described below.

## Search setup

Copy `.env.example` into your runtime environment and provide:

- `TYPESENSE_HOST` for server-side index administration
- `TYPESENSE_SEARCH_HOST` for browser search requests
- `TYPESENSE_COLLECTION`
- `TYPESENSE_SEARCH_API_KEY` and `TYPESENSE_ADMIN_API_KEY`

The project loads ignored `.env` and `.env.local` files for local commands;
shell and CI variables take precedence. The admin key is used only by
`npm run search:push`; the browser receives only the search-only key. Create a
search key from the admin key with:

```bash
npm run search:key:create
```

The command creates a key scoped to `documents:search` for the configured
collection and prints the generated key once. Store it as
`TYPESENSE_SEARCH_API_KEY` in your local environment or secret store.

For local development, set `TYPESENSE_SEARCH_HOST` to the browser-reachable
Typesense URL, normally `http://localhost:8108`. The Kubernetes image defaults
this value to the same-origin `/typesense` path. Its Nginx server exposes only
`POST /typesense/multi_search` and proxies that request to
`typesense-0.typesense-headless.outline.svc.cluster.local:8108`. This keeps the
cluster-only hostname out of browser requests. The search key remains visible
to the browser by design and must stay scoped to `documents:search`; never use
the admin key as the search key.

Then you can push search data:

```bash
npm run search:push
```

`search:push` uploads the same `.tmp/search-records.json` snapshot used by the
site, reconciles the native Typesense v30 synonym set
`<collection>-synonyms`, and links that set to the collection. Searchable text
fields use the `zh` locale tokenizer, while `search_tokens` keeps overlapping
Chinese n-grams available for mixed Chinese/English queries. Re-run
`npm run build:index` before pushing whenever the content snapshot changes.

## Jenkins and Kubernetes release

Production releases use Jenkins rather than GitHub Pages. GitHub Actions only
validates the retained legacy snapshot and does not need access to Outline or
Typesense secrets.

The Jenkins agent must run Linux with Node.js 20 or newer (Node.js 22 is
recommended), npm, Git, Docker, and, when Jenkins performs the rollout,
`kubectl`. It must have network access to Outline, the internal Typesense
service, the container registry, and the Kubernetes API. Allocate at least 4 GiB
of memory to the build agent; the release script supplies a 4 GiB Node.js heap
limit unless `NODE_OPTIONS` is already configured.

Configure these secret-text credentials as masked environment variables:

- `OUTLINE_API_TOKEN`
- `TYPESENSE_SEARCH_API_KEY`
- `TYPESENSE_ADMIN_API_KEY`
- `HARBOR_USERNAME` and `HARBOR_PASSWORD` when the Jenkins agent is not already
  authenticated to Harbor

Configure these non-secret environment variables:

```text
OUTLINE_URL=https://outline.qingflow.com
OUTLINE_COLLECTION=售后知识库(公开)
TYPESENSE_HOST=http://typesense-0.typesense-headless.outline.svc.cluster.local:8108
TYPESENSE_SEARCH_HOST=/typesense
TYPESENSE_BASE_COLLECTION=qingflow_help_docs
TYPESENSE_ALIAS=qingflow_help_docs_current
IMAGE_REPOSITORY=harbor.oalite.com/<project>/qingflow-help-center
DEPLOY_TO_K8S=true
KUBE_NAMESPACE=default
KUBE_DEPLOYMENT=qingflow-help-center
KUBE_CONTAINER=help-center
SMOKE_TEST_URL=http://qingflow-help-center.default.svc.cluster.local
```

Authenticate Docker to Harbor before running the release script. The Jenkins
shell step can use:

```bash
printf '%s' "$HARBOR_PASSWORD" | docker login harbor.oalite.com \
  --username "$HARBOR_USERNAME" --password-stdin
bash scripts/jenkins-release.sh
```

The script installs locked dependencies, validates the project, synchronizes
Outline exactly once, and builds the site plus search records from that one
snapshot. It creates and validates a versioned Typesense collection, packages
`build/` with `Dockerfile.runtime`, verifies Nginx configuration, and pushes an
immutable `<git-sha>-<jenkins-build-number>-<search-snapshot-hash>` image. After
the Kubernetes rollout succeeds it atomically points the stable Typesense alias
at the staged collection, then verifies both `/healthz` and an actual query
through `/typesense/multi_search`. A failed rollout or smoke test restores the
previous alias and executes `kubectl rollout undo`, so the previous site and
search snapshot remain available. Jenkins supplies `BUILD_NUMBER`
automatically; an explicit `IMAGE_TAG` overrides the generated tag. Set
`DEPLOY_TO_K8S=false` when another Jenkins stage or GitOps controller owns
deployment; this mode stages the versioned search collection without changing
the live alias.
`SMOKE_TEST_URL` may instead point to the public HTTPS site when the Jenkins
agent cannot resolve Kubernetes service DNS.

The committed `Jenkinsfile` restricts releases to `main`, disables concurrent
builds, applies a 60-minute timeout, and runs a full reconciliation every six
hours. Configure the multibranch job to inject the masked credentials above and
to build protected-branch pushes. For faster content publication, route Outline
webhook events through an authenticated internal relay or Jenkins integration
with event filtering and debounce; do not expose a Jenkins build token directly
to Outline. Every invocation performs a fresh full Outline sync, and generated
documents remain build artifacts rather than Git content. The search-only key
must be scoped to the stable alias (by default `qingflow_help_docs_current`).

## Key directories

```text
docs/                  Markdown and MDX content
src/pages/             Branded landing page and search page
scripts/               Outline sync, search record generation, and Typesense sync
typesense/schema/      Collection schema reference
.github/workflows/     CI pipeline
```

## Next suggested milestones

1. Connect a real Typesense instance and search-only API key
2. Add content freshness monitoring and stale versioned-index cleanup
3. Add OpenAPI-driven API reference pages
4. Add AI answer generation with source citations
