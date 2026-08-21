---
name: aily-coder-library
description: Use in Aily Coder mode when searching, installing, or removing official Arduino Component Libraries through the Coder Runtime. This skill does not manage Blockly libraries or Aily Coder external packages.
---

# Aily Coder Component Libraries

Use the Coder-owned tools only in a `coder` development-mode session. The active workspace is injected by the Agent and is not a model-controlled argument.

## Choose a library

1. Read `project.aci`, the board/framework, existing external dependencies, and immediate directories under `sketch/libraries/`.
2. Search with `coder_arduino_library_search`. Treat its opaque `id`, advertised versions, compatibility, installed state, and managed provenance as authoritative for this source.
3. Compare each plausible result with every required protocol, device, API, architecture, version, license, and timing constraint. A name match or successful build alone does not prove coverage.
4. Install only one exact compatible result with `coder_arduino_library_install` and the returned `id` plus exact version.
5. If no available result satisfies every key constraint, return to `aily-coder-project` and follow `aily-coder-local-library` to implement the missing capability under `sketch/libraries/`.

## Remove safely

1. Search again and require `installed=true`, `managed=true`, and an exact `installedVersion`.
2. Call `coder_arduino_library_remove` with the same opaque `id` and exact installed version.
3. If provenance is missing or conflicts, leave the directory untouched. Treat it as a possible intentional local or legacy component.

## Boundaries

- Never call Blockly `search_boards_libraries`, `lib_add`, or `lib_remove` for this workflow.
- Never invent an Arduino registry ID, version, package name, or successful search result.
- This source is independent from the future Aily Coder external-package catalog and its install/remove flow.
- Build through the existing host `project_build` tool after installation or local implementation.
