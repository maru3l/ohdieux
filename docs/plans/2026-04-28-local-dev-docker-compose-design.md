# Local Dev Docker Compose Design

## Goal

Add minimal Docker Compose configuration for local development that builds from source and runs Ohdieux with same runtime shape documented in `docs/DEPLOYMENT.md`.

## Context

- Root repo already has `Dockerfile` for multi-stage Play/Scala build.
- Deployment docs currently describe `docker build` plus `docker run` flow.
- Runtime uses `/data` volume for persistent app data and defaults to port `8080` in documented examples.
- No root compose file exists today.

## Options Considered

### 1. Single root compose file with inline environment variables

Recommended.

Pros:
- Smallest change.
- Mirrors existing deployment documentation closely.
- Easy `docker compose up --build` workflow for local development.

Cons:
- Less flexible than env-file based setup.

### 2. Compose file plus `.env`

Pros:
- Easier local overrides.
- Keeps compose file shorter.

Cons:
- Adds extra file and indirection without strong need.

### 3. Compose profiles for basic and archive modes

Pros:
- Supports multiple local modes in one config.

Cons:
- More config surface than current need.

## Chosen Design

Add root `docker-compose.yml` with one `ohdieux` service.

- `build: .` so local dev uses current source tree.
- `ports: 8080:8080` to match deployment docs.
- `environment` includes `PORT=8080` and `PUBLIC_URL=http://localhost:8080`.
- `volumes` mounts `./data:/data` for persistence across restarts.
- No archive-related variables by default, keeping local dev basic and low-risk on disk usage.
- Service name and container name stay simple and aligned with project name.

## Documentation Changes

Update `docs/DEPLOYMENT.md` with local development Compose section showing:

- `docker compose up --build`
- access URL
- note that data persists in `./data`

## Verification

Validate config with `docker compose config`.
