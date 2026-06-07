# Footlight — task runner.
# Root package = render engine + `footlight` CLI (src/, dist/, bin/).
# app/        = Tauri desktop GUI (separate npm package).
# Requires Node 26+; ffmpeg/ffprobe on PATH for anything end-to-end.

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Getting started
# ---------------------------------------------------------------------------

.PHONY: doctor
doctor: ## Check required tools (node 26+, ffmpeg, ffprobe) + optional (cargo)
	@bash scripts/doctor.sh

.PHONY: setup
setup: install app-install ## Install all dependencies (root engine + GUI)
	@echo "Setup complete. Run 'make doctor' to verify ffmpeg/node, then 'make gui'."

.PHONY: setup-system
setup-system: ## Install ffmpeg with libass (macOS/brew; needed for captions). Other OSes: see `make doctor`.
	@bash scripts/setup-system.sh

# ---------------------------------------------------------------------------
# Root: engine / CLI
# ---------------------------------------------------------------------------

.PHONY: install
install: ## Install root dependencies
	npm install

.PHONY: build
build: ## Compile the engine/CLI (tsc -> dist/)
	npm run build

.PHONY: test
test: ## Run the test suite once (vitest run)
	npm test

.PHONY: test-watch
test-watch: ## Run tests in watch mode
	npm run test:watch

# Run a single test file or name:  make test-one T=test/core.test.ts
#                                   make test-one T='-t "computeCrop"'
.PHONY: test-one
test-one: ## Run a single test file/name (T=...)
	npx vitest run $(T)

# ---------------------------------------------------------------------------
# CLI passthroughs (build first). Usage: make render M=manifest.csv
# ---------------------------------------------------------------------------

.PHONY: render
render: build ## Render a manifest: make render M=manifest.csv [ARGS=--dry-run]
	node bin/footlight.js render $(M) $(ARGS)

.PHONY: probe
probe: build ## Probe a source: make probe SRC=video.mp4
	node bin/footlight.js probe $(SRC)

.PHONY: scenes
scenes: build ## List scene cuts: make scenes SRC=video.mp4
	node bin/footlight.js scenes $(SRC)

# ---------------------------------------------------------------------------
# App: Tauri GUI (app/ is its own npm package)
# ---------------------------------------------------------------------------

.PHONY: app-install
app-install: ## Install GUI dependencies (in app/)
	cd app && npm install

# Depends on `build`: the dev server imports the shared pure command builders
# from dist/ (src/core.ts), so dist/ must exist first.
.PHONY: app-server
app-server: build ## Run the web dev backend (node:http on :8787)
	cd app && npm run dev:server

.PHONY: app-dev
app-dev: ## Run the Vite frontend in the browser (pairs with app-server)
	cd app && npm run dev

# Option A (no Rust): backend in the background + frontend; Ctrl-C stops both.
.PHONY: gui
gui: build app-install ## Run the GUI in the browser (backend + frontend)
	cd app && (npm run dev:server & SERVER_PID=$$!; \
		trap "kill $$SERVER_PID 2>/dev/null" EXIT INT TERM; \
		npm run dev)

# Option B (needs Rust toolchain). Uses the locally-installed @tauri-apps/cli
# (app/node_modules) so no global `cargo install tauri-cli` is required.
.PHONY: tauri-dev
tauri-dev: build app-install ## Run the native desktop window (needs Rust)
	cd app && npx @tauri-apps/cli dev

# Produces app/src-tauri/target/release/bundle/. This build is UNSIGNED and meant
# for LOCAL use — it is not notarized for distribution, so on another Mac it must
# be launched with right-click → Open (or `xattr -dr com.apple.quarantine` on the
# .app). The machine still needs ffmpeg/ffprobe/node on PATH (Footlight does not
# bundle them) — run `make doctor` to check. Build it on the Mac that will run it.
.PHONY: tauri-build
tauri-build: build app-install ## Build the native app locally (unsigned; needs Rust)
	cd app && npx @tauri-apps/cli build

# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------

.PHONY: clean
clean: ## Remove build output (dist/, coverage/)
	rm -rf dist coverage

.PHONY: distclean
distclean: clean ## clean + remove all node_modules and GUI build output
	rm -rf node_modules app/node_modules app/dist

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
