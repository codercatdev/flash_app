# Flash — Setup & CLI reference

## Setup

```bash
# install the CLI — requires Python 3.10-3.13 (NOT 3.14+ yet)
uv tool install runpod-flash
pip install runpod-flash
# on Python 3.14+ the install fails — pin an older interpreter for the tool:
uv tool install --python 3.13 runpod-flash

# auth option 1: browser-based login (saves token locally)
flash login
# headless: print URL instead of opening a browser
flash login --no-open
# max seconds to wait for browser auth (default 600)
flash login --timeout 300

# auth option 2: API key via environment variable
export RUNPOD_API_KEY=your_key

# scaffold a new project in ./my-project (writes AGENTS.md + CLAUDE.md)
flash init my-project
# scaffold in the current directory
flash init .
# overwrite existing files (-f)
flash init my-project --force
# update the CLI to the latest version
flash update
# pin a specific version (-V also works)
flash update --version 1.16.0
```

`flash init` writes `AGENTS.md` (+ a `CLAUDE.md` symlink). To add them to an existing project: `python -c "from runpod_flash.rules import install_agent_files; from pathlib import Path; install_agent_files(Path.cwd())"`.

**Auth precedence:** a set `RUNPOD_API_KEY` env var **overrides** the saved `flash login` token, so an exported bad/expired key silently beats a good login — a common trap (see Gotcha #13 in the skill).

## CLI

`flash dev` is the canonical dev-server command (`flash run` still works as a hidden alias).

```bash
# local server at :8888, but functions run on REMOTE GPU/CPU workers;
# hot-reloads on save and streams the worker's logs live to your terminal
flash dev
# same, but pre-provision endpoints (no cold start on first call)
flash dev --auto-provision
# custom port/host; --reload/--no-reload toggles autoreload
flash dev --port 9000 --host 0.0.0.0
# build + deploy (auto-selects env if only one)
flash deploy
# build + deploy to "staging" environment
flash deploy --env staging
# deploy a specific app to an environment
flash deploy --app my-app --env prod
# build + launch local preview in Docker
flash deploy --preview
# build flags below also apply to deploy
flash deploy --no-deps --python-version 3.11
# list deployment environments
flash env list
# create "staging" environment
flash env create staging
# show environment details + resources
flash env get staging
# delete environment + tear down resources
flash env delete staging
# list flash apps in your account
flash app list
# create a flash app
flash app create my-app
# show an app's environments + builds
flash app get my-app
# delete an app and all its resources
flash app delete my-app
# list all active endpoints
flash undeploy list
# remove a specific endpoint
flash undeploy my-endpoint
# remove all endpoints (--interactive/-i to pick, --force/-f to skip prompts)
flash undeploy --all
# remove endpoints whose code no longer exists locally
flash undeploy --cleanup-stale

# build-only (no deploy) — mainly for debugging the artifact; `flash deploy` builds for you
# package the artifact without deploying (1500MB limit; torch auto-excluded)
flash build
# build flags: --no-deps, --exclude pkg1,pkg2, --output name.tar.gz, --python-version 3.11
flash build --no-deps
```
