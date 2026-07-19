# SamQL beta channel

Durable dogfood line for soak testing before a stable AppWindow cut.

## Identity

| Item | Value |
|------|--------|
| Branch | `beta` |
| Current tip (as of channel setup) | build **2026-07-18.671** (v2.16.4) |
| GitHub prerelease tag pattern | `app-beta-<build>` |
| Stable (unchanged) | `master` + `app-<build>` **Latest** |

## Rules

1. **Do not** mark beta releases as GitHub **Latest**.
2. Beta tags are always **prerelease**: `app-beta-<build>`.
3. Product commits on `beta` still bump `BUILD` / `RELEASE_MANIFEST.json` /
   `VERSION` and refresh `samql_txt/` in the **same** commit.
4. Promote by merging `beta` → `master`, then cut `app-<build>` Latest after
   the usual `RELEASE_CHECKLIST.md` / Windows AppWindow package pass.
5. Temporary Cursor PR branches (`cursor/…`) are not the channel; merge them
   into `beta` (or into `master` after soak) and delete when done.

## Publish a beta AppWindow (Windows build PC)

```powershell
git fetch origin
git checkout beta
git pull origin beta
python tools/release_artifacts.py verify-tree --root .
.\build.ps1
# then create GitHub Release tag app-beta-<build> as prerelease with the zips
```

Confirm `/api/health` (or the AppWindow top bar) shows the expected `build`.

## What’s on beta today

NodeFlow sphere polish (groups/iterators/SQL as spheres with under-panels and rim port fan), container minimize, Field Explorer / modal responsiveness, and latest-data-wins pin reclaim / filecache hardening. See `VERSION` for the detailed build log.
