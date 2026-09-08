---
name: aily-coder-library
description: Use in Aily Coder mode when searching, installing, updating, or removing libraries from the regional Aily and Arduino official library catalogs.
---

# Aily Coder Libraries

Use `coder_library_search` for Aily libraries. It shares Blockly `libraries.json` and `libraries-index.json` and the main application's regional npm registry configuration. Install exact `blockly:@aily-project/lib-*` refs through `coder_library_install`: it retains the root dependency and npm package, then extracts `src.7z` into `sketch/libraries/`. For Arduino official libraries, use the same search tool with `source="registry"`: the regional `libraries-coder-index.json` returns `coder:@aily-project-coder/lib-*` refs. Install and remove these refs through the same tools and npm/`src.7z` workflow; `npm_registry_coder` selects the regional official package registry. The active workspace is injected by the Agent.

## Choose a library

1. Read root `package.json` for project configuration and declared packages, then inspect `sketch/libraries/`. A package under node_modules alone does not prove Coder source is ready.
2. Call `coder_library_search`. When the user supplied a library name, query that exact name first; use additional capability words only as ranking hints.
3. Compare every plausible result with the required protocol, device, API, architecture, version, license, and timing constraints. Use returned metadata, dependencies, includes, documentation, and installed source where available. A name match or successful build alone does not prove functional coverage.
4. Inspect `compatible`, `compatibility.supportedArchitectures`, and `compatibility.activeArchitectures` before installation. For a compatible result, install it with `coder_library_install`, copying its exact returned `libraryRef` and `version`.
5. If the user explicitly named and requested one library whose selected version is incompatible, explain the supported and current architectures, present up to three `compatibleAlternatives` as metadata-ranked candidates, and ask whether to install the named library anyway. Verify each candidate's actual API before describing it as functionally suitable. If the user confirms, call `coder_library_install` with `allowIncompatible=true`. If this confirmation times out, is skipped, or its UI is unavailable, the original explicit install request remains authoritative: install with `allowIncompatible=true`, then state clearly that the library was installed despite the compatibility warning and repeat the compatible alternatives. If the user declines, do not install it.
6. Never set `allowIncompatible=true` for a library chosen by the Agent or for a general capability request that did not explicitly name the library. Prefer a verified compatible alternative; if none satisfies the requirements, return to `aily-coder-project` and follow `aily-coder-local-library`.
7. Require `ready=true`, `packageJsonLinked=true`, and non-empty `libraryRoots` under `sketch/libraries/`. The Runtime validates and extracts the installed npm package's `src.7z`; one package can contain multiple library roots.
8. Inspect returned `packageDirectory`, `sourceDirectory`, and `libraryRoots`. Do not run npm or extract archives manually to bypass installation checks.
9. If no catalog result satisfies every key constraint, return to `aily-coder-project` and follow `aily-coder-local-library` to implement the missing capability under `sketch/libraries/`.
10. For any other failed install, including an HTTP 400 response, report that installation failed and preserve the returned error code and message for the user. Do not present it as installed or silently retry an unrelated failure with `allowIncompatible`.

## Remove safely

1. Search for the installed library and require `installed=true` and `managed=true`. If `managed=false`, leave the local or copied library untouched.
2. Copy the exact installed `libraryRef` and `installedVersion`; do not substitute the currently selected catalog `version`.
3. Call `coder_library_remove` with that `libraryRef` and `installedVersion`.
4. The Runtime resolves removal from the project-local managed receipt without an online catalog, uninstalls the associated npm package, and removes only its unchanged managed source roots. Existing managed ZIP libraries remain removable through their original refs.

## Boundaries

- Always use `coder_library_search`; do not call Blockly `lib_add` or `lib_remove` in Coder mode.
- Share the Blockly package/catalog installation through Coder tools; source consumed by the compiler remains under `sketch/libraries/`.
- An existing npm dependency alone is not source readiness. Use `coder_library_install` to materialize missing `sketch/libraries/` source roots.
- Treat `sketch/libraries/` as persistent project source. Do not edit a managed catalog library in place; use the project-local-library workflow when source customization is required.
- Build through the existing host `project_build` tool after installation or local implementation.
