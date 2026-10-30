<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-30 | Last verified: 2026-10-30 -->

# AGENTS.md

**Precedence:** closest `AGENTS.md` wins. This root file holds repo-wide rules only.

## Commands

| Task | Command | Verified |
|------|---------|----------|
| JavaScript syntax | `node --check web/vue_model_preview.js` | 2026-10-30 |
| Python syntax | `python -m py_compile __init__.py` | 2026-10-30 |
| Whitespace check | `git diff --check` | 2026-10-30 |

No automated test suite or build step exists. For behavior changes, smoke-test in a real ComfyUI page. Frontend-only changes need `Ctrl+F5`; Python changes need a ComfyUI restart.

## Workflow

1. Read the nearest `AGENTS.md`, `README.md`, and the code path being changed.
2. Reuse existing helpers. Do not add a bundler, frontend framework, or runtime dependency for a small change.
3. Run the smallest checks above. For browser behavior, test both the traditional canvas and Nodes 2.0 when the code touches shared menu logic.
4. Report only checks actually run. State any untested browser or deployment step explicitly.

## File Map

```text
__init__.py                  ComfyUI route, preview lookup, cache headers, extension exports
web/vue_model_preview.js     Models 2.0 and legacy canvas menus, thumbnails, persistence, widget matching
web/vue_model_preview.css    All .cvmp-* menu, tree, thumbnail, drag and focus styles
pyproject.toml               Package metadata and version
README.md                    User-facing features, install steps, supported model folders
```

## Golden Samples

| Area | Reference | Non-obvious rule |
|------|-----------|------------------|
| Preview route | `get_direct_model_preview` in `__init__.py` | Validate folder, path index and model path before reading files. Keep the redirect fallback. |
| Widget mapping | `FOLDER_PATTERNS` and `widgetFolder` | Match indexed third-party names centrally; do not add node-specific branches. |
| Persistence | `loadCategoryOrder`, `saveCategoryOrder`, `loadExpandedCategories` | Keep keys `cvmp.categoryOrder.v1` and `cvmp.expandedCategories.v1` backward-compatible. |
| Legacy menu | `renderLegacyMenu` and `patchLegacyModelWidgets` | Preserve search, keyboard, scroll and reopen-guard behavior. |
| Drag ordering | `onLegacyMenuDrop` and `onTreeDrop` | Both canvas paths must save the same per-folder category order. |
| Styling | `.cvmp-*` classes and existing CSS variables | Extend the current menu language; do not introduce a parallel design system. |

## Utilities

| Need | Use |
|------|-----|
| Model folder mapping | `widgetFolder()` |
| Cached model metadata | `loadFolderModels()`, `resolveModel()` |
| Preview loading | `previewUrl()`, `loadPreview()` |
| Widget values | `widgetModelNames()` |
| Icons | `makeIcon()` |
| Model selection | `selectModel()` |

## Heuristics

| When | Do |
|------|----|
| Supporting a new model folder | Update `FOLDER_PATTERNS`, `README.md`, and verify the widget names the upstream node exposes. |
| Supporting third-party widgets | Normalize separators and extend the regex table; keep matches anchored. |
| Changing persisted state | Keep or migrate the `.v1` key schema; never silently discard user order or expansion state. |
| Changing shared menu logic | Test both legacy canvas and Nodes 2.0; avoid opening both native and custom menus. |
| Changing Python routes | Preserve path traversal checks, HTTP caching behavior, and the fallback endpoint. |
| Releasing a version | Keep `__init__.py`, `pyproject.toml`, README, Git tag and GitHub Release aligned. |

## Boundaries

### Always Do

- Run the relevant syntax and whitespace checks before claiming completion.
- Keep preview paths inside the selected `folder_paths` root.
- Preserve `.cvmp-*` namespacing and existing keyboard/accessibility behavior.
- Keep the repo directly loadable by ComfyUI with `WEB_DIRECTORY = "./web"`.

### Ask First

- Add dependencies, a build system, or a new framework.
- Change public route URLs, widget-mapping semantics, or localStorage key names.
- Refactor both canvas implementations or replace the styling system.

### Never Do

- Bypass `folder_paths.is_within_directory` or trust client-provided paths.
- Commit model files, generated previews, `__pycache__`, secrets, or local deployment paths.
- Edit the installed ComfyUI copy as the source of truth; edit this repo, then deploy.
- Force-push without `--force-with-lease`.

## Scoped AGENTS.md

<!-- AGENTS-GENERATED:START scope-index -->
- No scoped AGENTS.md files.
<!-- AGENTS-GENERATED:END scope-index -->
