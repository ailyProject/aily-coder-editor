---
name: aily-coder-library
description: Use in Aily Coder mode when searching, installing, updating, or removing libraries through the unified preferred-Blockly then official-Arduino-candidate workflow.
---

# Aily Coder Libraries

Use one library-search concept in Coder mode. The shared `@aily-project/lib-*` catalog is preferred; official Arduino libraries are queried only as fallback candidates. Do not expose separate Component Library or external-package workflows. The active workspace is injected by the Agent and is not a model-controlled argument.

## Choose a library

1. Read root `package.json`, the board/framework, existing `@aily-project/lib-*` dependencies, and immediate directories under `sketch/libraries/`.
2. Call `coder_library_search` with its default `candidates=false`. This is the single "search libraries" entry and returns the preferred shared Blockly library results first. When the user supplied a library name, query that exact name first; use additional capability words only as ranking hints, then enforce the requirements by inspecting metadata and the extracted API. Evaluate those results completely before requesting any fallback candidates.
3. Compare each plausible result with every required protocol, device, API, architecture, version, license, and timing constraint. A name match or successful build alone does not prove coverage.
4. If all preferred results are absent, incompatible, or insufficient, call the same `coder_library_search` tool again with `candidates=true` to search official Arduino libraries as fallback candidates. Do not present this internal fallback tier as a separate library type or prefer it over a suitable shared result.
5. Install only one confirmed result with `coder_library_install`, copying its exact returned `libraryRef` and version.
6. For a preferred shared result, require `ready=true`, `packageJsonLinked=true`, `archive="src.7z"`, a package-relative `packageDirectory` and `sourceDirectory`, and non-empty `libraryRoots`. The Runtime keeps the intact `@aily-project/lib-*` package under `node_modules` and expands the archive's top-level `src/` directly into that package, for example `node_modules/@aily-project/lib-arduinojson/src/ArduinoJson/`. Inspect only the returned paths after the call completes; do not guess or probe `sketch/libraries/<name>`, `.aily`, or host cache paths.
7. If no preferred or fallback result satisfies every key constraint, return to `aily-coder-project` and follow `aily-coder-local-library` to implement the missing capability under `sketch/libraries/`.

## Remove safely

1. Confirm the exact installed `libraryRef` and version; for a preferred shared result also confirm its `@aily-project/lib-*` dependency in root `package.json`.
2. Call `coder_library_remove` with that exact `libraryRef` and version.
3. The Runtime removes the root `package.json` dependency through npm, so the intact `node_modules/@aily-project/lib-*` directory and its extracted `src/` disappear together. Any old flattened `sketch/libraries/` projection is migration-only and may be removed only after receipt/cache provenance and source-content verification; an unverified directory remains an intentional local library.

## Boundaries

- Always use `coder_library_search`; do not call `lib_add` or `lib_remove` in Coder mode because they do not own Coder `src.7z` materialization.
- Preferred shared results must be exhausted before official Arduino fallback candidates are queried. If neither tier has a suitable result, use the project-local-library workflow.
- Never edit installed `node_modules/@aily-project/lib-*` contents or their generated `src/` trees. The build consumes each package's returned `sourceDirectory` directly, while `sketch/libraries/` is reserved for intentional project-local libraries; use the project-local-library workflow for source changes.
- Build through the existing host `project_build` tool after installation or local implementation.
