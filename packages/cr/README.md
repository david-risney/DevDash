# cr

`@devdash/cr` is an independently installable Node.js 22+ CLI for anonymous
public Chromium bugs and Gerrit changes. It does not depend on DevDash.

```powershell
npm install --global .\packages\cr
cr --help
cr doctor
```

Browser installation is explicit (run from this package directory, or use
the same Playwright version as the installed CLI):

```powershell
npx playwright install chromium --only-shell
```

No command downloads or implicitly installs a browser. `doctor` checks the
installed executable without launching it or contacting providers; a failed
check returns exit code 2.

## Commands

```powershell
cr bugs view 411731002 https://crbug.com/123456 --limit 1 --pretty
cr bugs list --query 'type:bug status:open' --limit 10
cr cls list --query 'status:merged' --project chromium/src --limit 1
cr cls list --query 'status:open' --host https://chromium-review.googlesource.com
cr logs path
cr logs tail --lines 100 --errors
cr --version
```

`bugs view` takes 1–100 unique positive numeric string IDs of at most 16 digits,
or strict HTTPS URLs on `crbug.com/<id>`, `issues.chromium.org/issues/<id>`,
or `issues.chromium.org/u/<number>/issues/<id>`. Credentials, ports, query
strings, fragments and unofficial hosts are rejected. Bugs are rendered in
an anonymous, fresh Playwright context. Login, restricted issues and CAPTCHA
are reported, never bypassed.

`bugs list` requires a native [Issue Tracker search query](https://developers.google.com/issue-tracker/concepts/search-query-language).
It uses the public website, follows its next-page controls, and reads each
selected bug's details sequentially in the same fresh anonymous context.
Search strings are limited to 32768 characters without control characters.
Only public results are visible. Use explicit email addresses, not signed-in
shortcuts such as `me`; no existing login cookies are used. Native keywords,
qualifiers and Boolean operators are interpreted by the website, which can
treat unknown qualifiers as keywords. This is not a supported search API.
Saved-search IDs and host/project overrides are not supported; use native
qualifiers such as `componentid:123` to scope results.

The limit applies before any consumer's local filtering. Extra result rows or
an enabled next-page control set `truncated: true`; an exact-limit final page
does not. A verified "No issues match your search" page returns an empty list.
An unfinished page, invalid pagination, HTTP failure, denial or access challenge
fails explicitly, rather than looking like an empty successful result. Search
navigation and each results-page transition have 30-second deadlines, with at
most 400 search pages. A selected bug failing to load fails the entire command.
Search selectors may need maintenance when the public website changes.

`cls list` requires `--query`; `--project` scopes the query and validates returned
projects. `--host` must be an HTTPS origin without credentials, path, query or
fragment. The default is `https://chromium-review.googlesource.com`. Requests
time out after 30 seconds and reject redirects. Gerrit nanosecond timestamps
normalize to UTC milliseconds; pagination follows `_more_changes`, at most
200 pages, and reports conservative explicit truncation.

All query commands support `--limit` (1–20000, default 1000) and `--pretty`.
Value-taking options accept both `--name value` and `--name=value`. Use the
equals form for values beginning with `--`; exclusion queries such as
`--query=-status:merged` and projects beginning with `-` are supported.
Each successful query writes exactly one JSON document to stdout:

```json
{"schemaVersion":1,"items":[],"truncated":false}
```

CL items include normalized `targetBranch` when Gerrit returns `branch`;
leading `refs/heads/` is removed. This uses the same destination-branch concept
as DevDash's ADO PR results. Missing fields are omitted; an explicit null branch
remains null. DevDash's generic `filter` expressions run in DevDash after `cr`
returns results; they are not Gerrit expressions or additional `cr` options.

Each bug and CL item has a curated `providerData` object, never a raw upstream
payload. Shared concepts remain top-level: bug `priority`, `severity`, and
`type` are nullable strings; the Issue Tracker's component is
`providerData.component` (nullable). CLs expose `providerData.changeId` when
Gerrit supplies `change_id`; otherwise `providerData` is `{}`. State, priority,
severity, type, and identity values retain provider-native semantics.

This pre-1.0 output revision removes the former bug `details` object; the
envelope `schemaVersion` remains `1`. Update DevDash and `cr` together. DevDash
invalidates prior caches rather than migrating them; its legacy
`details.priority`/`component` filter spellings still work on the new fields.
No attention-set, submit-requirement, or ownership-policy evaluation is implied.

Help, version, doctor and log commands also write one structured JSON document.
Errors write only one JSON document to stderr and exit 1:

```json
{"error":{"code":"INVALID_ARGUMENT","message":"Safe explanation.","diagnosticId":"request UUID"}}
```

Error codes include `BROWSER_*`, `BUG_*`, `PROVIDER_*`, `INVALID_ARGUMENT`,
`LOG_WRITE_FAILED` and `LOG_READ_FAILED`. Raw browser/HTTP exception messages
are never exposed.

## Diagnostics

`--home <path>` applies to every command, overriding `CR_HOME` and default
`~/.cr`. Logs reside at `<home>/logs/cr.jsonl`. DevDash may set `CR_HOME`
to its own `logs/cr` directory and forward a UUID through `CR_REQUEST_ID`.
Only validated UUIDs are used; otherwise cr creates a new request ID.

Structured JSONL diagnostics contain timestamps, app/Node versions, session
and request IDs, fixed event/phase/error/reason codes, numeric bug IDs,
HTTP statuses, durations and counts. They omit query text, profile names,
credentials, page content, exception messages and subprocess stderr.
Interprocess locking protects rotation: at most five files, 2 MiB each.
Log write/lock failure is explicitly fatal; it is not silently ignored.
`logs tail` reads a bounded amount, with `--lines` from 1–1000 (default 100);
`--errors` filters failure records. It sanitizes returned records too.

There are no authentication, configuration profiles, caches, watch processes
or native-host functionality in cr.

## Tests

```powershell
npm test --prefix .\packages\cr
```

Tests mock provider/browser operations; they do not contact live sites or launch
a browser by default.
