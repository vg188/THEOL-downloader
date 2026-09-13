# THEOL Unit Study Feasibility

**Date:** 2026-09-13  
**Browser:** Chrome desktop（版本未提供）  
**Probe mode:** self-contained bookmarklet

## Current unit

- Same-origin frame access: pass
- Canonical existing preview links present: pass（一次有效单元页面显示 2 个）
- Preview metadata response: pass
- MIME family: html
- Declared charset: gbk
- Preview endpoint structure: `/meol/common/script/preview/download_preview.jsp` with query keys `fileid`, `lid`, `resid`
- Observed current frame structure: `/meol/jpk/course/layout/lesson/index.jsp` with `courseId`

A separate unit-study-like page showed zero preview links, previewCount=0, and metadata failure. Its frame structure was `/meol/jpk/course/layout/newpage/index.jsp` with `courseId`. This is recorded as an empty or unrecognized current unit page, not as evidence of a working preview route.

## All units

- Captured mechanism: href
- Endpoint type: `/meol/jpk/course/course_column_preview_transfer.jsp`
- Query-key set: `columnId`, `tagbug`
- Repeated route type observed: same endpoint and key set appeared in two page observations (counts 22 and 52 respectively)
- No navigation executed by probe: pass

An additional same-origin list structure was observed at `/meol/buildless/resFolderViewList.do` with keys `columnId`, `folderid`, `lid`. It is recorded as an observed auxiliary route only; it is not the captured unit-entry allowlist and must not be used until a production parser proves its course and page-role checks.

## Privacy boundary

- Courseware body requests: none
- Upload or telemetry: none
- Stored page/user data: none
- Full URLs, query values, names, filenames, and IDs recorded: none

## Decision

- Current unit: `UNIT_CURRENT_GO`
- All units: `UNIT_ALL_GO`

## Implementation gate

Production work may proceed using two distinct exact allowlists:

1. **Current unit preview allowlist** — pathname `/meol/common/script/preview/download_preview.jsp` with exact query-key set `fileid`, `lid`, `resid`. Used for preview metadata and download within the current unit context.
2. **All units entry allowlist** — pathname `/meol/jpk/course/course_column_preview_transfer.jsp` with exact query-key set `columnId`, `tagbug`. Used for enumerating unit entries across the course.

The implementation must validate every candidate against the current course context and the returned page role before reading metadata. It must retain the existing preview/download URL policy, GBK decoding, current-directory boundaries, and no-auto-navigation rule. The auxiliary route remains observational until separately validated.
