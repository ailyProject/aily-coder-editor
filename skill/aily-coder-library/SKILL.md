---
name: aily-coder-library
description: Use in Aily Coder mode when searching, installing, updating, or removing libraries from the region-specific Aily Coder library catalog.
---

# Aily Coder Libraries

Use `coder_library_search` as the only catalog search for Coder libraries. It reads `libraries-coder-index.json` from the main application's selected regional resource. It does not read Blockly `libraries.json` or `libraries-index.json`, install `@aily-project/lib-*` npm packages, or expand Blockly `src.7z` archives. A legacy `@aily-project/lib-*` dependency or `node_modules` copy is ignored even when it already exists. The active workspace is injected by the Agent and is not a model-controlled argument.

## Choose a library

1. Read root `package.json` only for project type, board, framework, and entry configuration, then inspect immediate directories under `sketch/libraries/`. Do not use root dependencies or `node_modules` for library discovery.
2. Call `coder_library_search`. When the user supplied a library name, query that exact name first; use additional capability words only as ranking hints.
3. Compare every plausible result with the required protocol, device, API, architecture, version, license, and timing constraints. Use returned metadata, dependencies, includes, documentation, and installed source where available. A name match or successful build alone does not prove functional coverage.
4. Inspect `compatible`, `compatibility.supportedArchitectures`, and `compatibility.activeArchitectures` before installation. For a compatible result, install it with `coder_library_install`, copying its exact returned `libraryRef` and `version`.
5. If the user explicitly named and requested one library whose selected version is incompatible, explain the supported and current architectures, present up to three `compatibleAlternatives` as metadata-ranked candidates, and ask whether to install the named library anyway. Verify each candidate's actual API before describing it as functionally suitable. If the user confirms, call `coder_library_install` with `allowIncompatible=true`. If this confirmation times out, is skipped, or its UI is unavailable, the original explicit install request remains authoritative: install with `allowIncompatible=true`, then state clearly that the library was installed despite the compatibility warning and repeat the compatible alternatives. If the user declines, do not install it.
6. Never set `allowIncompatible=true` for a library chosen by the Agent or for a general capability request that did not explicitly name the library. Prefer a verified compatible alternative; if none satisfies the requirements, return to `aily-coder-project` and follow `aily-coder-local-library`.
7. Require `ready=true`, a source directory under `sketch/libraries/`, and a non-empty `libraryRoots` result. The Runtime downloads the ZIP URL recorded in the regional Coder index, verifies its declared size and SHA-256 checksum, rejects unsafe archive paths and symbolic links, and atomically places the extracted Arduino library under `sketch/libraries/`.
8. Inspect only the returned `sourceDirectory` and `libraryRoots` after installation. Do not guess an npm package, write a root dependency, probe a Blockly cache, or install from a Blockly archive.
9. If no catalog result satisfies every key constraint, return to `aily-coder-project` and follow `aily-coder-local-library` to implement the missing capability under `sketch/libraries/`.
10. For any other failed install, including an HTTP 400 response, report that installation failed and preserve the returned error code and message for the user. Do not present it as installed or silently retry an unrelated failure with `allowIncompatible`.

## Remove safely

1. Search for the installed library and require `installed=true` and `managed=true`. If `managed=false`, leave the local or copied library untouched.
2. Copy the exact installed `libraryRef` and `installedVersion`; do not substitute the currently selected catalog `version`.
3. Call `coder_library_remove` with that `libraryRef` and `installedVersion`.
4. The Runtime resolves removal from the project-local managed receipt, so removal remains available while offline or after the current catalog stops listing the installed version. It removes only the matching `sketch/libraries/<LibraryName>` directory and refuses malformed, differently sourced, or version-mismatched provenance.

## Boundaries

- Always use `coder_library_search`; do not call Blockly `lib_add` or `lib_remove` in Coder mode.
- Never install a Coder catalog library through npm, `node_modules/@aily-project/lib-*`, `libraries.json`, `libraries-index.json`, or a package-local `src.7z`.
- Never treat an existing root `@aily-project/lib-*` dependency as installed, compatible, or usable Coder source. Only a matching catalog result installed under `sketch/libraries/`, or an intentional local library there, may satisfy the project.
- Treat `sketch/libraries/` as persistent project source. Do not edit a managed catalog library in place; use the project-local-library workflow when source customization is required.
- Build through the existing host `project_build` tool after installation or local implementation.
