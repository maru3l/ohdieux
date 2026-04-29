# Local Dev Docker Compose Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add root Docker Compose configuration for local development and document how to run it.

**Architecture:** Keep configuration minimal and aligned with existing single-container deployment flow. Compose builds from root `Dockerfile`, exposes port `8080`, and persists data in local `./data` directory.

**Tech Stack:** Docker Compose, Docker, Play Framework, Scala, Markdown docs

---

### Task 1: Add compose configuration

**Files:**
- Create: `docker-compose.yml`

**Step 1: Write failing test**

Configuration change only. No automated test file needed.

**Step 2: Run test to verify it fails**

Run: `docker compose config`
Expected: FAIL because root `docker-compose.yml` does not exist.

**Step 3: Write minimal implementation**

Create `docker-compose.yml` with:

```yaml
services:
  ohdieux:
    build: .
    container_name: ohdieux
    environment:
      PORT: "8080"
      PUBLIC_URL: http://localhost:8080
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
```

**Step 4: Run test to verify it passes**

Run: `docker compose config`
Expected: PASS and rendered config output.

### Task 2: Update deployment documentation

**Files:**
- Modify: `docs/DEPLOYMENT.md`

**Step 1: Write failing test**

Documentation change only. No automated test file needed.

**Step 2: Run test to verify it fails**

Run: `docker compose config`
Expected: PASS. Documentation has no executable failure mode.

**Step 3: Write minimal implementation**

Add local development Compose section near Basic Deployment that:

- explains `docker compose up --build`
- notes app listens on `http://localhost:8080`
- notes persisted data stored in `./data`

**Step 4: Run test to verify it passes**

Run: `docker compose config`
Expected: PASS.

### Task 3: Verify final result

**Files:**
- Verify: `docker-compose.yml`
- Verify: `docs/DEPLOYMENT.md`

**Step 1: Run verification**

Run: `docker compose config`
Expected: PASS with resolved compose configuration.

**Step 2: Review diff**

Run: `git diff -- docker-compose.yml docs/DEPLOYMENT.md docs/plans/2026-04-28-local-dev-docker-compose-design.md docs/plans/2026-04-28-local-dev-docker-compose.md`
Expected: Only planned config and documentation changes.
