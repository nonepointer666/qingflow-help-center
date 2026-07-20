# Qingflow Help Center

This repository implements **Phase 1** of a self-hosted help center based on:

- `GitHub` for code and Markdown content storage
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

## Build

```bash
npm run build
```

This will:

- build the Docusaurus site into `build/`
- generate `.tmp/search-records.json` for Typesense indexing

## Search setup

Copy `.env.example` into your runtime environment and provide:

- `TYPESENSE_HOST`
- `TYPESENSE_SEARCH_API_KEY`
- `TYPESENSE_ADMIN_API_KEY`
- `TYPESENSE_COLLECTION`

Then you can push search data:

```bash
npm run search:push
```

## Key directories

```text
docs/                  Markdown and MDX content
src/pages/             Branded landing page and search page
scripts/               Search record generation and Typesense sync
typesense/schema/      Collection schema reference
.github/workflows/     CI pipeline
```

## Next suggested milestones

1. Connect a real Typesense instance and search-only API key
2. Add synonym rules and ranking strategy
3. Introduce Decap CMS for browser-based editing
4. Add OpenAPI-driven API reference pages
5. Add AI answer generation with source citations
