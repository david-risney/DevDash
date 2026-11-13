# DevDash

A JSON-first Node.js CLI that gives scripts, browser extensions, and Dragon
pipelines one place to configure developer queries and share cached results.

| Provider | Bugs | Reviews | Transport |
| --- | --- | --- | --- |
| GitHub / GitHub Enterprise | Issue search | PR search | Installed `gh` CLI by default; explicit anonymous REST mode also supported |
| Azure DevOps | Flat WIQL or saved query ID | PR list with repository, author, reviewer, status, and source/target branch filters | Installed `az` CLI and `azure-devops` extension |
| Chromium | Anonymous public bug search or explicit IDs | Public Gerrit CL search | Installed standalone `cr` CLI |

Chromium's current bug tracker is Google Issue Tracker, not Gerrit. The separate
`cr` tool renders its public bug pages in a fresh, unauthenticated headless Chromium
context and extracts metadata. This is an unofficial website adapter, not a
supported Issue Tracker API. It cannot access restricted issues and does not
use your browser's login cookies. Chromium CL queries use public Gerrit
endpoints, not your browser's Gerrit login.

## Install and start

Requires Node.js **22 or newer**. From this checkout:

With PowerShell **7.3 or newer**, use the checkout launcher:

```powershell
.\devdash.ps1 --help
.\devdash.ps1 doctor
.\devdash.ps1 get edge --format ansi
.\devdash.ps1 get edge --query my-prs --cached-only --format md
.\devdash.ps1 watch edge --format ansi
```

It forwards arguments unchanged to Node, preserves the CLI's exit code, and
runs `npm ci` in the checkout when npm dependencies are missing. Installation
messages go to stderr so JSON stdout remains usable. It also adds the
checkout's `node_modules\.bin` to the child process's PATH, making the local
workspace `cr` available without a global install. Relative configuration paths
still resolve from your current directory, not the script's directory.
For piped JSON, use `Get-Content -Raw .\dashboard.json | .\devdash.ps1 format --format md`.
After changing dependency manifests or the lockfile, run `npm ci` to synchronize
installed versions; the launcher checks availability, not dependency versions.

The launcher does not install Node, provider CLIs/extensions, or browser binaries,
and does not sign you in. For anonymous Chromium bug queries, install the browser
once with `npx playwright install chromium` after npm dependencies are present.
Gerrit queries do not require a browser.

Alternatively, install the commands globally:

```powershell
npm ci
npm install --global .\packages\cr
npm install --global .
cr --help
devdash --help
devdash doctor
```

Installation is local; nothing needs to be published to npm. You can instead
run `node .\bin\devdash.js <arguments>` without installing globally.
DevDash and [`@devdash/cr`](packages/cr/README.md) are independently installable
packages. DevDash does not bundle Playwright or import Chromium browser/network
code; it requires `cr` on PATH for Chromium profiles, just as it requires `gh`
and `az` for their profiles. GitHub/ADO profiles and cached-only reads do not
require `cr`.

Authenticate the provider tools using their normal login flows:

```powershell
gh auth login
az extension add --name azure-devops
az login
```

Azure DevOps can also use `az devops login --organization <URL>` or the
`AZURE_DEVOPS_EXT_PAT` environment variable when required by your organization.
Credentials stay with those tools or the environment, **not in DevDash JSON**.
DevDash never installs CLI extensions automatically. `doctor` checks tool
availability, not whether a particular query is authorized.

Create a grouped profile with four named queries. First replace the two
saved-query GUIDs and `you@example.com` in
[`examples\edge.profile.json`](examples/edge.profile.json) with your own saved
query IDs, organization, project, repository, and email. Its historical filename
does not identify any real organization's configuration:

```powershell
devdash init
devdash profile set edge --file .\examples\edge.profile.json
devdash get edge
devdash refresh edge
devdash cache status edge
devdash get edge --query my-prs
```

`profile set` can also create a missing configuration, so `init` is optional.
`init` refuses to overwrite an existing file.

### Convert JSON to readable output

Choose the output format directly on `get`, `refresh`, or `watch`. JSON remains
the default for scripts, pipelines, and browser/native messaging consumers:

| Option | Output |
| --- | --- |
| `--format json` | Original structured results; use `--pretty` to indent |
| `--format ansi` | Colored tables with emoji, linked titles and clickable item IDs |
| `--format ascii` | Plain-text tables with ASCII dividers and copyable URLs; no generated escapes or icons |
| `--format md` | Compact Markdown tables with linked item IDs |

From this checkout:

```powershell
node .\bin\devdash.js get --all --cached-only --format md

node .\bin\devdash.js get edge --format ansi

node .\bin\devdash.js get edge --query my-prs --cached-only --format ascii

node .\bin\devdash.js refresh edge --format ansi
```

Save Markdown or use the integrated `format` command to convert **one JSON
document from stdin** without querying providers or changing caches:

```powershell
node .\bin\devdash.js get --all --cached-only --format md |
  Set-Content -Encoding utf8 .\dashboard.md

Get-Content -Raw .\dashboard.json | node .\bin\devdash.js format --format ascii
```

Human output inherits user presentation settings. For saved JSON, add
`--config <file>` to `format` when you also want that file's profile/query
overrides; without it, `format` does not read a query configuration.

These options replace the former `scripts\json-to-*.js` converters. `ascii`
keeps source Unicode text intact; only generated table syntax is ASCII.
`watch` keeps JSON-lines output by default; human formats append a table/report
for each refresh or error, without clearing the terminal. Other commands
(configuration, diagnostics, native host/manifest) remain JSON-only.
`--pretty` cannot be combined with a non-JSON format. Fatal command errors
remain JSON on stderr regardless of the selected output format.

Single-query, grouped-profile, batch, and standalone `cr` query-result envelopes
are supported. Each query gets a friendly table: **Item, Title, Status, and
Assignee** for bugs or **Author** for reviews. Priority, severity, and updated
date (UTC) appear only when supplied; repository becomes a column only when
the list spans repositories, otherwise Markdown/plain text show it once in the
section heading. ANSI omits column labels and the separate section preamble.
The assignee/author column is omitted when every row has the same person or
assignee set (including single-row lists and all-unassigned lists). Assignee
order does not matter; mixed assigned/unassigned or differing people retain the
column. This is decided independently for each query, not for the whole report.
Dates use `MM-DD` for the current UTC year and `YYYY-MM-DD` for other years.
Drafts are labeled clearly. Status values get readable capitalization, not
cross-provider semantic remapping.

The renderers show empty lists, per-query errors, cached/refreshed summaries, and
truncation warnings. They intentionally omit JSON field names, exact cache
timestamps, diagnostic IDs, labels, branches, reviewer votes, and raw
`providerData`; use the original JSON for those details. They do not infer an
actionable review obligation from votes.
Config/doctor/cache-status documents and watch's multiple-document stream are
not query-result inputs.

ANSI mode deliberately emits terminal controls even when redirected; choose
plain text for logs or terminals without ANSI support. Clickability depends on
terminal OSC 8 support; plain text includes copyable URLs below each table.
ANSI mode also uses Nerd Fonts Codicons for the dashboard, pull requests/changes,
and warnings. A blue title band with bold ice-blue text replaces the column
labels and separate query preamble. It includes the profile/query name and item
count, followed by a parenthesized fetch age (minutes, hours, or days ago) only
when the snapshot is **older than two minutes**. This uses `fetchedAt`, not an
item's change date; missing or future fetch timestamps show no age.
The title links to the snapshot's optional `queryUrl`: GitHub/Gerrit/Chromium
native searches or an ADO saved bug query. ADO WIQL and PR filters use the closest
project query page or repository PR list, not an equivalent filtered view.
Local DevDash filters and fetch limits are not applied on those websites.
Existing caches gain `queryUrl` at read time without migration or a refresh;
older exported JSON and standalone `cr` results use a closest list/item link
when their item URLs provide one. Empty old exports without a query URL have an
unlinked title.

Half-block sides (`U+2590` / `U+258C`) and a bottom edge (`U+2580`, with
matching quadrant corners) frame the table in its title band's background color.
The border stays that color through wrapped lines, alternating rows, warnings,
and empty/error panels. There is no separate top border: the title band is the
top. Border glyphs use the title fill as their foreground on the terminal's
default background, so the outside stays transparent. These standard Unicode
Block Elements do not require a Nerd Font.
The older `"quarter"` style uses filled Unicode 16 quarter-circle corners
and straight row-colored sides; `"semicircle"` uses Nerd Font Powerline caps
(`U+E0B6` / `U+E0B4`) on every band. Neither adds a bottom border row.
There are no internal dividers. The title sits above subtly
alternating slate row backgrounds. Foreground colors distinguish statuses and pink
priority/severity values, while secondary details use a softer blue-gray.
Every wrapped line of an item keeps the same background, including empty cells
and column spacing. Colors reset at each line boundary, so they do not bleed
into the next query or shell prompt. The table uses an explicit dark,
high-contrast RGB palette and requires a true-color terminal.
Markdown keeps its pipe-table syntax and plain text keeps ASCII dividers.

Select a Nerd Font in your
terminal (preferably a Mono variant, such as CaskaydiaCove Nerd Font Mono);
DevDash does not install fonts. Bug rows cycle through caterpillar, lady
beetle, ant, honeybee, cricket, and mosquito emoji using the numeric bug ID modulo
six, so the same ID always gets the same emoji without losing large-ID
precision. Nerd Font glyphs and these generated emoji are ANSI-only.
The palette avoids newer U+1FAxx emoji such as the beetle (U+1FAB2), which
older browser-terminal width tables count as one cell instead of two and can
therefore shift table columns. The honeybee is used in that slot instead.
Console columns adapt to the terminal width (100 columns when redirected,
minimum 24). Narrow terminals drop optional columns first, then the
assignee/author column if necessary; item, title, and status remain visible.
Long cells wrap rather than being truncated. Unicode emoji/CJK/combining
sequences are accounted for when aligning cells, although exact glyph widths
can vary by terminal font. Markdown retains the full table without console
width limits.

Untrusted text is flattened and stripped of terminal
controls, Markdown labels are escaped, and item links require credential-free
HTTPS URLs. All formats are included in the installed `devdash` command.

Exit codes are `0` for successful rendering, `1` for invalid input or I/O, and
`2` when rendered results contain provider/query failures. Invalid input to
`format` is reported on stderr without echoing private JSON; input is limited to
32 MiB.
Fatal DevDash errors normally go to its stderr, not through the JSON pipeline.
Use `devdash --help` for the JSON command reference.

### User themes and per-query presentation overrides

ANSI, ASCII, and Markdown share one format-neutral table model: the same
sanitized rows, dynamic columns, counts, warnings, dates, and link destinations.
Renderers apply decoration afterward. Styling does not change item selection,
provider requests, or the JSON item contract.

User defaults live in `<home>\user.config.json` (`~\.devdash\user.config.json`
normally). `--home` / `DEVDASH_HOME` also isolate this file; `--user-config <file>`
selects another one. A missing default file uses built-in styling; an explicitly
selected missing file is an error. Start with
[`examples\user.config.json`](examples/user.config.json), validated by
[`presentation.schema.json`](presentation.schema.json).

Precedence, from lowest to highest:

1. Built-in defaults.
2. User config's `presentation`.
3. Query configuration file's root `presentation`.
4. Profile/query group's `presentation`.
5. Individual named query's `presentation` (or a flat profile's `presentation`).

Inheritance is automatic; no file includes or `extends` declarations are needed.
Objects merge recursively, scalar values override, and arrays (such as row
stripes) replace the entire inherited array. A replacement row inherits omitted
style properties from the built-in base row, not from an earlier stripe array.
Named palette colors remain available to narrower scopes; a query can redefine
a palette name or reference a color introduced by its file/group.
Settings are resolved at command startup; restart `watch` after theme edits.

For example, the user config can define colors and reference them in table styles:

```json
{
  "version": 1,
  "presentation": {
    "ansi": {
      "palette": {
        "heading": "#34465b",
        "ink": "#e0e8f0",
        "stripeA": "#1f2933",
        "stripeB": "#27333f"
      },
      "table": {
        "cornerStyle": "half",
        "header": { "background": "p:heading", "foreground": "p:ink", "bold": true },
        "rows": [
          { "background": "p:stripeA", "foreground": "p:ink" },
          { "background": "p:stripeB", "foreground": "p:ink" }
        ],
        "columns": {
          "title": { "foreground": "p:ink" },
          "priority": { "foreground": "#f3a5cf", "bold": true }
        }
      }
    },
    "ascii": { "links": true, "table": { "separator": " | ", "junction": "-+-" } },
    "md": { "headingLevel": 2, "table": { "align": { "priority": "center" } } }
  }
}
```

Put a smaller `presentation` object at the file root, profile/group, or query
to override only what changes. See
[`examples\styled.config.json`](examples/styled.config.json) for all three scopes.
For example, a query's `"presentation": {"ansi": {"table": {"header":
{"background": "#573648"}}}}` changes just its title band's background.

ANSI `palette` values are six-digit hex colors. Styles accept literal
`#RRGGBB` or `p:name` references, plus `bold`. `table.header`, `table.rows`
(one to eight repeating logical-row styles), and `table.columns` support
foreground/background/bold. Column keys are `item`, `title`, `status`, `person`,
`repository`, `priority`, `severity`, and `updated`. `table.states.active`,
`.closed`, and `.draft` supply semantic status accents; explicit column styles
override those accents. `table.missing` styles `-` cells, `table.warning` styles
truncation notices, and `table.error` styles error panels. Column background
colors cover their padding and restore the row background before the next gap.
`ansi.links`, `ansi.icons`, and `ansi.table.caps` can each be disabled.
`ansi.table.cornerStyle` selects `"half"` (default), `"quarter"`, or
`"semicircle"`; `caps: false` disables side shapes and any bottom border.

ASCII supports `links` and printable ASCII `table.separator` / `table.junction`
(one to three characters, equal lengths). Markdown supports `links`,
`headingLevel` (2–6), and `table.align` per column (`left`, `center`, `right`).
These affect presentation only; turning off links never removes item IDs.
Errors, empty lists, truncation warnings, and partial-failure exit codes
cannot be hidden by a theme. Stale-cache warnings are no longer displayed in
human formats; JSON retains `stale`, and ANSI titles still show fetch age.

### Glyphs, borders, and spacing

ANSI geometry follows the same user/file/group/query inheritance as colors.
`table.cornerStyle` supplies a preset; `table.border` overrides its individual
properties. Preset-derived glyphs are not stored as overrides, so choosing
another preset at a narrower scope works without copying a full definition.
Explicit inherited overrides still take precedence over a new preset.

`table.padding` is the horizontal inset on each side (0–3 cells).
`table.gap` is the total whitespace between columns (0–6 cells).
`table.separator` inserts a connecting string between columns, in addition to
that gap, with the whitespace split before and after it. The default is an
empty separator and a two-cell gap. Narrow terminals shrink gaps and padding
as needed before wrapping; all geometry is budgeted in display cells.

For example, this embedded `presentation` keeps half-block framing, adds a
column connector, and makes every border use a named color:

```json
{
  "ansi": {
    "palette": { "frame": "#34465b" },
    "glyphs": { "warning": "!", "pr": "\uea64", "cl": "\ueafc" },
    "table": {
      "cornerStyle": "half",
      "padding": 1,
      "gap": 2,
      "separator": "\u2502",
      "border": {
        "left": "\u2590",
        "right": "\u258c",
        "foreground": "p:frame",
        "bottom": { "left": "\u259d", "fill": "\u2580", "right": "\u2598" }
      }
    }
  }
}
```

`border.left` and `.right` repeat on every physical line. Optional
`titleLeft` / `titleRight` replace the first title line's sides;
`lastLeft` / `lastRight` replace the final content/message line's sides.
`top` and `bottom` are separate horizontal rules: each is either `false`
or an object with `left`, `fill`, and `right` glyphs. When adding a rule not
supplied by the preset, supply all three properties; an existing rule can be
overridden partially. `caps: false` disables all sides and rules.
`colorSource` is `"header"` (the half-block default) or `"row"`;
an explicit `foreground` color overrides that choice.
`filledSides: true` paints space-valued sides with the row background, as in
the quarter-corner preset.

To try pixel fades down both sides, override only:

```json
{
  "ansi": {
    "table": {
      "border": {
        "left": "\ue0c7",
        "right": "\ue0c6",
        "top": false,
        "bottom": false
      }
    }
  }
}
```

`ansi.glyphs` supports `dashboard`, `warning`, `pr`, `cl`, and `bugs` (an
ordered array of 1–32 bug icons, selected using the exact bug ID modulo its
length). `ansi.icons: false` suppresses them without changing row data.
Icons must be one visible grapheme occupying one or two terminal cells.
Border glyphs must be one cell; side glyphs may also be empty. Horizontal
rule glyphs cannot be empty. Separators may span up to four cells.
Controls, directional formatting characters, invalid widths, and unknown
settings are rejected rather than emitted to the terminal. Use a font that
supports the chosen characters; Nerd Font glyphs remain optional.

Unknown options, malformed colors, missing palette references, and terminal
control sequences are rejected explicitly. Shape validation is part of the
query configuration schema; palette references are validated after the full
user/file/group/query cascade is resolved, before provider access for human
output. User presentation settings are not loaded for JSON/native consumers.
Theme-only edits neither invalidate nor rewrite query caches, and themes are
never sent to provider CLIs or stored in normalized snapshots.

### Chromium bugs

The standalone `cr` bug adapter requires Playwright's bundled Chromium browser. Install it
explicitly; querying never downloads software or launches a visible window:

```powershell
npm exec --workspace @devdash/cr -- playwright install chromium --only-shell
cr bugs view 411731002
cr bugs list --query "type:bug status:open" --limit 10
cr cls list --query "status:open" --project "chromium/src" --limit 10
devdash profile set chromium-bugs --file .\examples\chromium-bugs.profile.json
devdash get chromium-bugs
```

Run the workspace installation command from this checkout so it uses `cr`'s
declared Playwright version. For an independently installed `cr`, use the browser
installation instructions in its README. Linux hosts may also require Playwright's
system dependencies (add `--with-deps`, with appropriate administrator permission).

`cr` is usable directly from PowerShell, pipelines, or other programs without
DevDash configuration. Its successful query output is
`{ "schemaVersion": 1, "items": [...], "truncated": false }`; `--pretty` indents
JSON. `cr bugs view` also accepts public `crbug.com` / Issue Tracker URLs.
Profiles, refresh policies, named lists, and caching remain DevDash's responsibility.

For search, use a native [Issue Tracker query](https://developers.google.com/issue-tracker/concepts/search-query-language)
string, not Gerrit syntax or DevDash's local filter syntax:

```json
{
  "provider": "chromium",
  "resource": "bugs",
  "query": "type:bug status:open",
  "filter": "priority:p2",
  "refreshSeconds": 900,
  "limit": 10
}
```

See [`examples\chromium-bug-search.profile.json`](examples/chromium-bug-search.profile.json).
Search follows the public website's pagination, then fetches each selected bug's
details in the same anonymous browser context. `limit` bounds retrieved bugs
**before** DevDash filtering; extra results or an enabled next-page control
make `truncated: true`. Exact-limit complete results are not marked truncated.
Only publicly visible issues can match; use explicit email addresses rather
than signed-in-user shortcuts such as `me`. Native syntax and its interpretation
belong to Issue Tracker; saved-search IDs and host/project overrides are not
supported. Scope a search using native qualifiers such as `componentid:123`.

To track specific bugs instead, use numeric strings in `query.bugIds` (up to
100 unique IDs). ID selectors and search strings cannot be combined:

```json
{
  "provider": "chromium",
  "resource": "bugs",
  "query": { "bugIds": ["411731002"] },
  "refreshSeconds": 900,
  "limit": 10
}
```

Lookups reuse one browser context per profile and fetch sequentially. `limit`
caps the number of requested IDs; remaining IDs make `truncated: true`.
Title and status must render before a result can be cached. HTTP failures,
access restrictions, load timeouts, selector failures, and malformed data are
reported explicitly. If any selected bug fails, the entire refresh fails and
the previous snapshot remains available via `--cached-only`.

Bug results also include top-level `priority`, `severity`, and `type`, plus
`providerData.component` for the Issue Tracker component. Missing values are
`null`. The former `details` output object is no longer emitted.
This adapter returns metadata, not comments or attachments. Website selectors
may need updating when Google changes the tracker UI; diagnostic logs identify
the bug ID and failing phase without storing page content. Use a conservative
refresh interval, such as 900 seconds, rather than repeatedly loading pages.

## JSON configuration

By default, configuration is stored at `~\.devdash\config.json` and cached
results under `~\.devdash\cache`. Set `DEVDASH_HOME` to use another data
directory, or pass `--home <directory>`. All consumers running as the same
user with the same data directory share the cache.

`--config <file>` selects a different config file. Its cache is isolated from
other config files even if they share the data directory. Relative paths are
resolved from the invoking process's working directory.

```json
{
  "version": 1,
  "profiles": {
    "my-prs": {
      "provider": "github",
      "resource": "prs",
      "repository": "david-risney/DevDash",
      "query": "is:open author:@me",
      "refreshSeconds": 120,
      "limit": 100
    },
    "edge-bugs": {
      "provider": "ado",
      "resource": "bugs",
      "organization": "https://dev.azure.com/YOUR-ORG",
      "project": "YOUR-PROJECT",
      "query": { "queryId": "01234567-89ab-cdef-0123-456789abcdef" },
      "refreshSeconds": 300
    },
    "chromium-cls": {
      "provider": "chromium",
      "resource": "cls",
      "project": "chromium/src",
      "query": "status:open owner:you@example.com",
      "refreshSeconds": 120
    }
  }
}
```

See [`config.schema.json`](config.schema.json) for the complete machine-readable
schema and [`examples\config.json`](examples/config.json) for all query types.
Unknown fields, unsupported combinations, invalid refresh intervals, and
credential-bearing URLs are rejected.

A profile can group named queries and return a separate list for each, or use
the original flat single-query definition shown above. Both forms retain
configuration `version: 1` and result `schemaVersion: 1`; existing flat profiles
and consumers remain compatible. Profile and query names are case-sensitive
and contain 1-80 letters, digits, dots,
underscores, or hyphens, starting with a letter or digit.

| Field | Meaning |
| --- | --- |
| `refreshSeconds` | Required on a flat profile or grouped profile; optional override on each grouped query. Cache lifetime in seconds, from 1 to 31,536,000 |
| `limit` | Optional; maximum provider items fetched before local filtering, default 1,000, range 1-20,000 |
| `filter` | Optional DevDash substring filter applied to normalized query results before caching |
| GitHub `repository` | Optional single `owner/repository`; omit both repository fields to search across all repositories accessible to the selected account |
| GitHub `repositories` | Optional array of 1-100 unique `owner/repository` names; searches that subset with repeated native `repo:` qualifiers. Cannot be combined with `repository` |
| GitHub `account` | Optional gh-authenticated login for this query. Omitted means gh's current active account/environment authentication. Does not switch gh's active account; not supported with anonymous auth |
| GitHub `query` | Search qualifiers; defaults to `state:open`. `bugs` means issues; add `label:bug` if desired |
| GitHub `hostname` | Optional GitHub Enterprise hostname, without a scheme |
| GitHub `auth` | `gh` (default) or `anonymous`. Anonymous mode uses credential-free REST and rejects signed-in-user shortcuts such as `@me`; it is never an authentication-failure fallback |
| ADO `organization`, `project` | Required HTTPS organization URL and project name or ID |
| ADO bugs `query` | Object containing exactly one of `wiql` (flat WIQL text) or `queryId` (saved query GUID). Bug work items are returned by default |
| ADO bugs `workItemTypes` | Optional explicit work-item type names, for example `["Bug", "Task"]`. The default is `["Bug"]`; set this when migrating widgets that intentionally show other types |
| ADO PR `repository` | Optional name or ID; omitted means project-wide PRs |
| ADO PR `query` | Object containing optional `author`, `reviewer`, `sourceBranch`, `targetBranch`, and `status`. Empty/omitted means active PRs in the configured scope |
| ADO PR `query.status` | `active` (default), `completed`, `abandoned`, or `all` |
| ADO PR `query.author`, `query.reviewer` | One identity or an array of identities accepted by `az repos pr list`; `author` maps to Azure's `--creator`. Arrays mean OR within each selector, with author/reviewer combinations unioned and deduplicated before the final limit |
| ADO PR `query.sourceBranch`, `query.targetBranch` | Native branch restrictions passed to `--source-branch` / `--target-branch` |
| Chromium CL `query` | Required Gerrit search expression; use your email for owner/reviewer |
| Chromium CL `project` | Optional Gerrit project filter, such as `chromium/src` |
| Chromium CL `host` | Optional HTTPS origin; defaults to `https://chromium-review.googlesource.com` |
| Chromium bugs `query` | Native Issue Tracker search string, or object containing `bugIds`: 1-100 unique numeric strings. Saved-search IDs, host, and project overrides are not supported |

ADO saved query folders, tree queries, and link queries are not flat bug queries
and are rejected. Include `System.Id` in WIQL selections; missing metadata is
hydrated with bounded, explicitly scoped `az boards query` batches. This avoids
ambiguous `az devops invoke` work-item routes while preserving the CLI's existing
authentication. Provider scopes come from query definitions rather than
the current Git checkout.

### GitHub accounts and repository subsets

Each query can select a different already-authenticated account. DevDash obtains
that account's credential through `gh auth token --user` and uses a child-process
environment only; it never runs `gh auth switch`, stores the token, or changes
the caller's environment. A missing account or mismatched authenticated identity
is an explicit error, not a fallback to another account. `@me` resolves to the
selected account. Without `account`, authentication remains owned by gh, including
its environment-token precedence. Use explicit accounts for stable multi-account
caches; changing gh's default alone does not invalidate an existing query cache.

```json
{
  "refreshSeconds": 300,
  "queries": {
    "work-reviews": {
      "provider": "github",
      "resource": "prs",
      "account": "example-work",
      "query": "is:open review-requested:@me"
    },
    "personal-issues": {
      "provider": "github",
      "resource": "bugs",
      "account": "example-personal",
      "repositories": ["example/project-one", "example/project-two", "example/project-three"],
      "query": "is:open assignee:@me"
    }
  }
}
```

Omitting repository fields searches **accessible** repositories, not just
repositories owned by the account. Use native `user:` or `org:` qualifiers if
ownership is the desired scope. A subset can also be expressed directly in
`query`, for example `is:open repo:example/one repo:example/two`; the repeated
`repo:` qualifiers mean either repository. Native repository qualifiers may narrow
a configured subset, but cannot select repositories outside it. One query uses one
account; use separate named queries for multiple accounts. Limits apply across
the entire query, before local filtering, not independently per repository.

Results retain their actual `repository` and URL. GitHub `id` remains the native
issue/PR number and can repeat across repositories; consumers should key rows
by `url` or by provider, repository, and id rather than id alone. Account and
repository-scope edits invalidate the affected query cache.
An organization may separately require SSO authorization for each account's
gh application or token. `GITHUB_SSO_REQUIRED` means that authorization is
missing for a provider read, even when search itself succeeds. Authorize the
selected account through the organization's approved browser flow and retry;
DevDash preserves the last good cache rather than skipping inaccessible PR
metadata or borrowing another account's credentials.

### Provider query versus DevDash filter

Each named query has two independent parts. **`query` is provider-specific**:
GitHub search text and Gerrit search text retain their native syntax; ADO PR
queries expose only the Azure CLI's finite filters, not arbitrary search text.
ADO bugs accept WIQL or a saved-query ID; Chromium bugs accept Issue Tracker
search text or explicit IDs.
Organization, project, repository/host, refresh policy, and limits stay outside
that query parameter object.

**`filter` is always local**, never passed to `gh`, `az`, or `cr`. Use the
simple string syntax below or opt into JavaScript predicate expressions:

```json
{
  "provider": "ado",
  "resource": "prs",
  "organization": "https://dev.azure.com/YOUR-ORG",
  "project": "YOUR-PROJECT",
  "repository": "YOUR-REPOSITORY",
  "query": {
    "author": "you@example.com",
    "targetBranch": "main",
    "status": "active"
  },
  "filter": "title:\"memory leak\" draft:false",
  "refreshSeconds": 120
}
```

Whitespace-separated terms have **implied AND**. `property:value` requires a
case-insensitive literal substring in that property's value; a bare value
matches any property value in the normalized item, including array entries
and nested provider data. Different terms can match different fields/array entries.
Property keys themselves are not searched. Null/missing values do not match.
An omitted, empty, or whitespace-only filter matches all fetched items.

```text
title:cache state:open
"memory leak" author:alice
source-branch:feature targetBranch:main reviewer:bob
priority:p2 component:accessibility
```

Use single/double quotes for phrases. Quote an entire bare URL or other value
containing a colon to avoid interpreting it as `property:value`, for example
`"https://example.com"`. Backslash escapes quotes, backslash, colon, or
whitespace; ordinary backslashes before other characters remain literal.
There are no Boolean operators, regexes, wildcards, or implicit `@me`
resolution: they are literal text in a local filter. Native `query` syntax is
unaffected. Filters are capped at 32,768 characters and 256 terms.

Shared concepts use these canonical names; keys are case-insensitive and
camelCase, kebab-case, and underscore spellings are interchangeable:

| Canonical property | Accepted concept aliases |
| --- | --- |
| `title` | `subject` |
| `author` | `creator`, `owner`, `createdBy` |
| `state` | `status` |
| `assignees` | `assignee`, `assignedTo` |
| `labels` | `label`, `tags`, `tag`, `hashtags` |
| `repository` | `repo` |
| `createdAt`, `updatedAt` | `created`, `updated` |

All providers also expose `id`, `url`, `provider`, `kind`, `draft`, and
`providerData`. The latter matches extension values, not property names.
`identities` searches curated identity metadata; `author`, `assignee`, and
`reviewer` also match available display names, logins, and IDs, not avatar URLs.
State values keep their provider semantics, rather than forcing ADO/Gerrit
states into GitHub's enum. Additional fields depend on the provider/resource:

| Provider/resource | Additional filter properties |
| --- | --- |
| GitHub | `labelDetails`, `providerData.nodeId`, `providerData.commentCount` |
| GitHub issues | `providerData.closureReason` |
| GitHub PRs | `reviewers` (`reviewer`), `providerData.merged`, `providerData.mergedAt`, `providerData.requestedReviewers`, `providerData.requestedTeams` |
| ADO bugs/work items | `priority`, `severity`, `type` |
| ADO PRs | `sourceBranch`, `targetBranch`, `reviewers` (`reviewer`), `providerData.mergeStatus`, `providerData.reviewerVotes`; opt-in `providerData.properties` |
| Chromium CLs | `targetBranch` (`branch`), `providerData.changeId`, `providerData.codeReviewScores`, `providerData.insertions`, `providerData.deletions`, `providerData.unresolvedCommentCount`; `project` aliases `repository` |
| Chromium bugs | `priority`, `severity`, `type`, `providerData.component` (`component`); legacy `details`, `details.priority`, `details.severity`, `details.type`, and `details.component` filters remain accepted |

ADO `sourceRefName`/`targetRefName` and Gerrit `branch` become shared branch
concepts; leading `refs/heads/` is removed in normalized results.
GitHub PR detail hydration supplies requested reviewers; branches are still not
local GitHub filter properties. Use native GitHub `head:`/`base:` qualifiers
in `query` instead. Filters search returned metadata, not full issue
bodies/comments or arbitrary raw provider fields. Unknown/unavailable
properties and malformed expressions are `INVALID_FILTER` errors, validated
before querying or saving configuration.

Filtering happens **after the bounded provider fetch and before caching**.
`limit` does not mean "keep fetching until this many matches": a filter may
return fewer or zero items. `truncated` retains the provider's signal even
when every fetched item is filtered out. Changing a filter invalidates only
that query's cache; CLI, watch, native messaging, and pipeline consumers all
receive the same filtered lists. Logs record source/match/removed counts but
never the expression or values. See
[`examples\filtered.profile.json`](examples/filtered.profile.json).

#### Opt-in ADO PR properties

Property retrieval is separate from both provider-native `query` and local
`filter`. ADO PR queries can request named properties through the standard
read-only PR properties API:

```json
{
  "include": { "properties": ["ReviewMetadata"] },
  "filter": {
    "language": "javascript",
    "expression": "JSON.parse(item.providerData.properties[params.key].$value).ready === true",
    "params": { "key": "ReviewMetadata" }
  }
}
```

Only the selected properties are retained under `providerData.properties`,
with ADO's native `{ "$type": "...", "$value": ... }` scalar envelopes.
JSON stored in a string property is not decoded automatically. Property
names, domain schemas, identities, and policy logic belong in your own
configuration; DevDash contains no team-specific property decoder.
ANSI, ASCII, and Markdown accept enriched snapshots but omit property payloads
from their tables; JSON retains the complete selected metadata.

Requests are limited to the bounded, deduplicated PR results, not the extra
truncation probe, with at most four property reads in flight per query.
`include.properties` accepts 1–20 unique nonblank names, at most 256 characters
each, without commas or control characters. Each retained property collection
is limited to 1 MiB. Without `include`, no extra requests or property data are
added. Changing `include` invalidates that query's cache.

A successful read with no matching property produces `properties: {}`. That
is **missing metadata**, not proof of no outstanding obligations: either
retain the item for triage explicitly or fail when the data is required.
HTTP, malformed/partial response, and property validation failures fail the
query and preserve its last good cache. No failed read is converted into an
empty collection.

#### JavaScript predicate filters

For Boolean logic, comparisons, nested collections, or JSON parsing, use an
explicit JavaScript filter object. Existing string filters are unchanged.

```json
{
  "filter": {
    "language": "javascript",
    "expression": "!item.draft && hasText(item.title, params.text) && item.providerData.reviewerVotes.some(v => v.reviewer === params.reviewer && v.vote === 0)",
    "params": {
      "text": "cache",
      "reviewer": "reviewer@example.com"
    }
  }
}
```

The expression receives `item` (one normalized result), `params` (an optional
JSON object, default `{}`), `now` (a fixed epoch-millisecond timestamp shared
by all items in that refresh), and `hasText(value, text)`. Inputs are deeply
read-only copies; each item gets independent globals and built-ins. Expressions
must return a primitive `true` or `false` synchronously, not a truthy value,
Boolean object, or Promise; scheduling asynchronous work is also rejected.
Statements are not accepted as the top-level filter, but functions and
immediately invoked functions inside an expression are supported.

JavaScript uses real, case-sensitive field names, **not** the string filter's
aliases. For example, use `item.author`, not `item.owner`. `hasText` recursively
searches string/number/Boolean **values**, not keys, using the string filter's
NFC-normalized, case-insensitive substring semantics; null/missing values do
not match. For identity-aware author matching, explicitly include the desired
metadata, such as `hasText([item.author, item.identities?.author?.login,
item.identities?.author?.displayName, item.identities?.author?.id], params.me)`.
There is no implicit current-user lookup.

Example predicates:

```javascript
hasText(item.title, "memory leak") && hasText(item.state, "open")
item.labels.includes("regression") || item.priority === "P1"
item.providerData.reviewerVotes.some(v => v.reviewer === params.me && v.vote === 0)
JSON.parse(item.providerData.metadata).ready === true
Date.parse(item.updatedAt) >= now - params.maxAgeDays * 86400000
```

Only fields already returned by the provider are available. Filters do not
fetch additional data or decode provider-specific extension schemas.
Missing required fields, malformed JSON, thrown errors, non-Boolean results,
and resource limits fail the query explicitly and preserve the previous
cache. Error messages/logs omit source, parameters, item contents, and thrown
exception text. Syntax is checked before querying or saving configuration.
JavaScript retains its usual missing-data semantics: `!undefined` is true,
optional chaining may yield undefined, and `[].every(...)` is true. When
completeness matters, require the field and validate its shape explicitly;
DevDash cannot infer whether missing metadata means unknown or known-empty.

Execution uses QuickJS WebAssembly, not Node's `eval` or `vm`. No filesystem,
network, process/environment, credentials, module loader, provider calls, or
other host bindings are exposed. A worker enforces a 10-second wall-clock
deadline, including startup; the interpreter additionally has cooperative
CPU budgets of 100 ms per item and 5 seconds per batch, a 16 MiB allocation
limit, and a 512 KiB stack limit. CPU accounting uses the worker thread on
Node versions that support it, or conservatively the entire process on older
Node 22. The hard worker deadline also covers engine operations between
interrupt checks. Limits are fixed, not executable configuration.
Expressions are limited to 32,768 characters; params to 64 KiB of JSON,
32 nesting levels and 10,000 values; inputs to 1 MiB per item, 16 MiB and
20,000 items per query. Limit violations are errors, never partial matches.
Evaluation errors use `FILTER_FAILED`, invalid results `FILTER_RESULT`, and
input/time limits `FILTER_LIMIT`; invalid definitions use `INVALID_FILTER`
or schema validation's `INVALID_CONFIG`.

For Node callers of `devdash/filters`, `compileFilter` stays synchronous.
Use `await filterItems(items, compileFilter(definition, profile))` for either
mode: string filters still return arrays synchronously; JavaScript filters
return a Promise.

Filtering still happens before caching. Relative-time predicates use the
refresh's `now`, not a new time on each cache read; use `now` rather than
`Date.now()` when comparing all items to the same instant. Cache-only reads
never evaluate predicates. Changing the expression or params invalidates
that query's cache. The same behavior applies to foreground and detached
refreshes, CLI, watch, pipelines, and native messaging. See
[`examples\javascript-filter.profile.json`](examples/javascript-filter.profile.json)
for a complete public profile.

Legacy ADO WIQL strings, top-level saved `queryId`, ADO PR
`creator`/`reviewer`/`status`, and Chromium `bugIds` remain supported. Do not
combine legacy parameters with their object-query replacements: conflicts
are rejected rather than silently overriding or widening the query.

### Named multiple-query profiles

Use a grouped profile for a dashboard with multiple lists. The Edge example
contains `bugs`, `security-bugs`, `my-prs`, and `review-prs`:

```json
{
  "refreshSeconds": 300,
  "queries": {
    "bugs": {
      "provider": "ado",
      "resource": "bugs",
      "organization": "https://dev.azure.com/YOUR-ORG",
      "project": "YOUR-PROJECT",
      "query": { "queryId": "01234567-89ab-4def-8123-456789abcdef" }
    },
    "security-bugs": {
      "provider": "ado",
      "resource": "bugs",
      "organization": "https://dev.azure.com/YOUR-ORG",
      "project": "YOUR-PROJECT",
      "query": { "queryId": "12345678-9abc-4def-8123-456789abcdef" }
    },
    "my-prs": {
      "provider": "ado",
      "resource": "prs",
      "organization": "https://dev.azure.com/YOUR-ORG",
      "project": "YOUR-PROJECT",
      "repository": "YOUR-REPOSITORY",
      "query": { "author": "you@example.com" },
      "refreshSeconds": 120
    },
    "review-prs": {
      "provider": "ado",
      "resource": "prs",
      "organization": "https://dev.azure.com/YOUR-ORG",
      "project": "YOUR-PROJECT",
      "repository": "YOUR-REPOSITORY",
      "query": { "reviewer": "you@example.com" },
      "refreshSeconds": 120
    }
  }
}
```

The GUIDs are syntactically valid placeholders, not real saved queries.
Replace them with distinct saved **flat** bug query IDs and replace the email
for both PR lists before fetching. Adjust organization, project, or repository
if your scope differs; omitting a PR repository queries the whole project.

`queries` must contain 1-100 named query objects. Each query uses the same
provider-specific fields as a flat profile and owns its scope: there are no
shared provider defaults. A group can mix providers and resources. Nested
groups are rejected. Queries inherit the required profile `refreshSeconds`
unless they override it; each query independently defaults to `limit: 1000`
and can override it with a value from 1 to 20,000.

### Managing profiles

```powershell
devdash config show --pretty
devdash config validate
devdash config validate .\examples\config.json
devdash profile list
devdash profile get my-prs
devdash profile get edge
devdash profile set edge --file .\examples\edge.profile.json
devdash profile set my-prs --file .\my-prs.json
devdash profile remove my-prs
```

`profile set` expects **one flat or grouped profile object**, not the whole config.
It replaces the complete profile, rather than merging queries, and removes
obsolete query caches. Removing a profile removes all its query caches. `--file -`
reads that object from stdin:

```powershell
$profile = @{
    provider = 'github'
    resource = 'prs'
    repository = 'david-risney/DevDash'
    query = 'is:open author:@me'
    refreshSeconds = 120
}
$profile | ConvertTo-Json | devdash profile set my-prs --file -
```

You can also edit the configuration file directly. Query or refresh-policy
changes invalidate the affected cache entries on the next read. Changing one
grouped query does not invalidate unchanged queries.

## Cache and refresh behavior

```powershell
devdash get my-prs
devdash get edge
devdash get edge --query my-prs
devdash get edge --query security-bugs --cached-only
devdash get --all
devdash get my-prs --cached-only
devdash refresh my-prs
devdash refresh edge --query review-prs
devdash refresh --all
devdash refresh --all --due
devdash cache status --all
devdash cache status edge --query bugs
devdash cache clear my-prs
devdash cache clear edge --query bugs
devdash cache clear edge
devdash cache clear --all
```

`get` returns a fresh matching cache immediately. On a miss or expiry it queries
the provider and saves a new snapshot. `refresh` always queries; `--due` skips
fresh snapshots. `--cached-only` never contacts a provider and explicitly marks
expired snapshots `stale: true`; a missing or invalidated snapshot is an error.

### Adaptive cached reads with background refresh

Opt in when you want cached results immediately while slow or unfamiliar queries
refresh independently:

```powershell
.\devdash.ps1 get edge --cache-mode adaptive --format ansi
devdash get edge --query my-prs --cache-mode adaptive
devdash get --all --cache-mode adaptive --fast-query-ms 750
```

| Cache / timing history | Adaptive behavior |
| --- | --- |
| Matching cache is younger than `refreshSeconds` | Return it; no provider call or worker |
| Cache is missing or query configuration changed | Fetch in the foreground, save, then return new data |
| Cache has expired; speed is unknown or not consistently fast | Return the old snapshot and start a detached background refresh |
| Cache has expired; recent refreshes are consistently fast | Wait for a foreground refresh and return the new snapshot |
| A background worker already handles that query | Reuse that worker rather than starting another |

Every successful refresh records its elapsed provider/filter time, including
refreshes initiated by normal `get`, `refresh`, `watch`, and native messaging.
The last **five** samples are retained per matching query definition. A query
is considered fast after at least **three** samples, only when **every retained
sample is at most 500 ms**. `--fast-query-ms` overrides that threshold for the
current adaptive read (integer 1–60000). Cache hits do not count as timing
samples. Old caches without history are treated as unknown speed, not migrated.
The threshold is a prediction, not a hard foreground deadline: a previously
fast provider can still take longer on its next request.

Each query's `refreshSeconds` remains the minimum cache age for another refresh;
adaptive mode does not refresh data that is still fresh. Presentation-only
changes preserve timing history, while query/filter changes invalidate it with
the cached results. `cache clear` removes both results and timing history.
Default `get`, `--cached-only`, forced `refresh`, and `watch` retain their existing
policies. Adaptive mode is only valid on `get` and cannot be combined with
`--cached-only`; a fast-query threshold requires adaptive mode.

Adaptive JSON query envelopes add `refreshStatus`: `fresh`, `scheduled`,
`running`, or `complete`. `fromCache` and `stale` describe the returned snapshot,
not the eventual background result. Cached output is not printed again when
the worker finishes; a later read observes the updated cache. The existing
human-readable formats work unchanged.

The worker inherits the invoking process's environment/provider tools, uses the
same absolute home/config paths, opens no terminal window, and continues after
the CLI or native-host client exits. It shares the normal per-query cache lock,
rechecks freshness before fetching, and refuses to commit results if that query
changes or its refresh reservation was cleared. Different queries can refresh
in separate workers; duplicate requests for the same query share a reservation.
Each worker exits after its one refresh; this does not create an always-running
daemon or install/authenticate anything.

Background failures preserve the last good cache. They cannot retroactively
change the cached response's exit code: inspect `cache status`'s
`backgroundRefresh` (`state`, timestamps, and a sanitized failure `code`) and
structured diagnostics instead. Status also exposes `refreshTiming.samples`
and `refreshTiming.maxMs`; timing samples are not added to normal result items.
An exited worker whose reservation still says `running` appears as `interrupted`
and a subsequent adaptive read can retry it. Worker startup failures are immediate
command errors. Foreground provider failures remain errors, without an implicit
stale fallback.

```powershell
devdash cache status edge --query my-prs
devdash logs tail --errors
```

### Scheduling and concurrency

Foreground grouped queries execute sequentially and independently, with separate caches
and expiry times. Successful queries persist even when another fails; failed
queries preserve their last good snapshot but never silently return it as a
successful refresh. `--cached-only` reports `CACHEMISS` separately for each
missing query. Changing an unrelated query does not abort an in-flight refresh;
changing or deleting the current query prevents its old result being committed.

`--query <name>` selects one query on `get`, `refresh`, `cache status`,
`cache clear`, or `watch`. Unknown or invalid names produce explicit errors.
It requires a grouped profile and cannot be combined with `--all` or a flat
profile. Without a selector, cache status/clear cover all queries in the profile.

There is **no hidden background daemon**. Expiry alone does not launch a query;
an adaptive read explicitly starts a one-shot worker when needed.
For automatic refresh, have a scheduler invoke `refresh --all --due`, or run:

```powershell
devdash watch
devdash watch my-prs --interval 5
devdash watch edge
devdash watch edge --query review-prs --interval 5
```

`watch` runs in the foreground, polls every second by default, reloads profiles,
and refreshes due snapshots. It emits one JSON line per actual refresh or error;
fresh-cache skips produce no output. Failed queries are reported and retried on
later polls. Ctrl+C stops subsequent refreshes; an in-flight query finishes first.
The polling interval is a scheduling granularity, not a replacement for each
query's `refreshSeconds`. Watching a whole group emits the whole grouped result:
`event: "error"` if any query failed, otherwise `event: "refreshed"` only when
an actual refresh occurred (`fromCache: false`). `--query` watches only that query.

Writes use atomic replacement and per-file interprocess locks.
Windows reader/scanner sharing violations are retried for up to one second
without deleting the existing snapshot; persistent failures remain explicit.
Concurrent on-demand reads of a missing/expired snapshot share the resulting refresh.
Explicit forced refreshes are serialized but are not silently skipped. Locks
are heartbeated; abandoned locks become recoverable after about 30 seconds.
A contending command waits up to roughly 10 seconds before reporting `BUSY`.
Use a local filesystem for the data directory.

A failed refresh **does not replace a good cache** and is not returned as success.
You can deliberately read the last snapshot with `--cached-only`. Queries have
bounded pagination, CLI/network timeouts, and explicit `truncated` metadata.
GitHub search cannot return more than 1,000 items. The Azure Boards CLI also
applies a roughly 1,000-row query cap; results at that boundary are conservatively
marked truncated. A larger `limit` cannot bypass those provider caps.

Profiles should query the intended account explicitly. If you switch the active
`gh` or `az` identity, clear or refresh cached results: cache keys reflect the
configuration, not the provider tool's current credentials.

## JSON result contract

Normal commands print one JSON document to stdout, with no progress text.
`--pretty` changes only indentation. A grouped profile returns one envelope
containing independent named query envelopes (empty lists shown here):

```json
{
  "schemaVersion": 1,
  "profile": "edge",
  "queries": {
    "bugs": {
      "schemaVersion": 1,
      "profile": "edge",
      "query": "bugs",
      "provider": "ado",
      "resource": "bugs",
      "fetchedAt": "2026-10-07T07:00:00.000Z",
      "expiresAt": "2026-10-07T07:05:00.000Z",
      "truncated": false,
      "items": [],
      "stale": false,
      "fromCache": false
    },
    "security-bugs": {
      "schemaVersion": 1,
      "profile": "edge",
      "query": "security-bugs",
      "provider": "ado",
      "resource": "bugs",
      "fetchedAt": "2026-10-07T07:00:00.000Z",
      "expiresAt": "2026-10-07T07:05:00.000Z",
      "truncated": false,
      "items": [],
      "stale": false,
      "fromCache": false
    },
    "my-prs": {
      "schemaVersion": 1,
      "profile": "edge",
      "query": "my-prs",
      "provider": "ado",
      "resource": "prs",
      "fetchedAt": "2026-10-07T07:00:00.000Z",
      "expiresAt": "2026-10-07T07:02:00.000Z",
      "truncated": false,
      "items": [],
      "stale": false,
      "fromCache": false
    },
    "review-prs": {
      "schemaVersion": 1,
      "profile": "edge",
      "query": "review-prs",
      "provider": "ado",
      "resource": "prs",
      "fetchedAt": "2026-10-07T07:00:00.000Z",
      "expiresAt": "2026-10-07T07:02:00.000Z",
      "truncated": false,
      "items": [],
      "stale": false,
      "fromCache": false
    }
  },
  "failed": 0,
  "stale": false,
  "fromCache": false
}
```

Each `items` array contains normalized items, as in the single-query example
below. Read the four output lists separately using
`result.queries['bugs'].items`, `result.queries['security-bugs'].items`,
`result.queries['my-prs'].items`, and `result.queries['review-prs'].items`.
Selecting `--query my-prs` returns just that query's flat envelope, including
`profile: "edge"` and `query: "my-prs"`.

A failed query occupies its own map entry instead of a success envelope:

```json
{
  "profile": "edge",
  "query": "security-bugs",
  "provider": "ado",
  "resource": "bugs",
  "error": {
    "code": "CACHEMISS",
    "message": "No cached result is available.",
    "diagnosticId": "example-request-id"
  }
}
```

Grouped `failed` counts failed queries. The entire grouped result remains on
stdout even on partial failure, with exit code `2`; other lists remain
available. In an `--all` batch, `failed` counts profiles with any failure,
not individual queries. A selected query failure uses the single-command
error contract and exit code `1`.

Legacy flat single-query profiles retain their original envelope without
a `query` field:

```json
{
  "schemaVersion": 1,
  "profile": "my-prs",
  "provider": "github",
  "resource": "prs",
  "fetchedAt": "2026-10-07T07:00:00.000Z",
  "expiresAt": "2026-10-07T07:02:00.000Z",
  "truncated": false,
  "items": [
    {
      "provider": "github",
      "kind": "pr",
      "id": "42",
      "title": "Add a query adapter",
      "state": "open",
      "url": "https://github.com/david-risney/DevDash/pull/42",
      "repository": "david-risney/DevDash",
      "author": "example-user",
      "assignees": [],
      "labels": [],
      "createdAt": "2026-10-06T12:00:00.000Z",
      "updatedAt": "2026-10-07T06:59:00.000Z",
      "draft": false,
      "providerData": {}
    }
  ],
  "stale": false,
  "fromCache": false
}
```

IDs are strings. `kind` is `bug`, `pr`, or `cl`. State strings retain provider
semantics; missing timestamps/author/repository/draft are `null`, and missing
assignees/labels are empty arrays. Timestamps are UTC ISO 8601. ADO PRs do not
expose a general modification time, so `updatedAt` is `null`. Raw provider
responses and credentials are not included.
`bug` is the shared issue/work-item category; use `type` for an ADO work item's
literal type when explicitly querying non-Bug work items.

ADO PR results can additionally include `sourceBranch`, `targetBranch`, and
`reviewers`; GitHub PRs can include `reviewers`, and Chromium CLs can include
`targetBranch`. Optional branch metadata
is omitted when the provider did not return the field, or `null` when explicitly
absent. These fields use the same names understood by the local filter.

Every item has a **`providerData` object**, empty when no curated extensions
are available. Shared concepts stay at the top level, even if only one
provider currently supplies them: Chromium bugs and ADO work items expose
`priority`, `severity`, and `type` rather than hiding them in `details`. Other
adapters omit unsupported fields; they do not invent values. Priority,
severity, type, state, and identity values retain provider-native semantics.

| Provider/resource | Curated `providerData` fields |
| --- | --- |
| GitHub bugs/PRs | `nodeId`: opaque GraphQL node ID; `commentCount`: nonnegative count when supplied |
| GitHub issues | `closureReason`: nullable native reason, such as `completed` or `not_planned` |
| GitHub PRs | `merged`: boolean; nullable `mergedAt`; `requestedReviewers` and `requestedTeams`: string arrays when supplied |
| ADO bugs | None yet (`{}`) |
| ADO PRs | `mergeStatus`: nullable native merge status; `reviewerVotes`: array of `{ reviewer, vote, required }` when reviewers were supplied; opt-in `properties`: selected native typed property envelopes |
| Chromium bugs | `component`: nullable Issue Tracker component string |
| Chromium CLs | `changeId`; `codeReviewScores`: array of `{reviewer, score}` with scores from -2 to 2; nonnegative `insertions`, `deletions`, and `unresolvedCommentCount` when supplied |

Optional `identities` preserves display metadata without changing existing
`author`, `assignees`, or `reviewers` strings:
`{author?: Identity, assignees?: Identity[], reviewers?: Identity[]}`, where each
identity has optional nonempty `id`, `login`, `displayName`, and HTTPS `avatarUrl`
strings. Missing source values are omitted; no token or embedded image is
included. GitHub `labelDetails` preserves `{name, color}` with a validated
`#rrggbb` color while keeping `labels` as strings. GitHub PRs hydrate missing
detail data with bounded concurrency, within the search API's 1,000-result
ceiling. Gerrit requests detailed label/account metadata but remains anonymous.

ADO reviewer identities use the same normalization as top-level `reviewers`.
Votes are native `-10`, `-5`, `0`, `5`, or `10`, or `null` when not supplied;
`required` is boolean or `null`. A missing reviewer collection omits
`reviewerVotes`; an explicitly empty/null collection becomes `[]`. Missing
merge status is omitted; explicit null remains null. Neither reviewer assignment
nor these votes establish an outstanding approval obligation: ownership
policies, file-set signoffs, and Gerrit submit requirements are not evaluated.

For example, a Chromium bug can contain:

```json
{
  "priority": "P2",
  "severity": "S2",
  "type": "Bug",
  "providerData": { "component": "UI>Accessibility" }
}
```

These are validated extension allowlists, not raw upstream response dumps.
The same item shape reaches refresh/get, caches, and the native messaging host.
This pre-1.0 item-shape revision replaces the old Chromium `details` object;
envelope `schemaVersion` and input config `version` remain `1`. Existing
snapshots are invalidated by the cache fingerprint, not migrated. Refresh once
after updating; `--cached-only` reports a cache miss until then. Update DevDash
and standalone `cr` together; nonempty old-style `cr` output is rejected rather
than silently relabeled as the new shape.

Batch commands return `{ "schemaVersion": 1, "results": [...], "failed": 0 }`.
Each failed profile has `{ "profile": "...", "error": { "code": "...",
"message": "...", "diagnosticId": "..." }` alongside successful results.
Grouped profiles appear in `results` with their own `queries` map, including
any per-query errors.

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Invalid arguments/config, missing cache, provider failure, or I/O error for a single command |
| `2` | One or more failures in a grouped profile, batch, or `doctor`; stdout still contains the structured report |

Flat-profile or selected-query failures emit a JSON error on **stderr**, with no
success output on stdout. Provider stderr is not echoed because it may contain credentials or
private diagnostics. Run the failing `gh`/`az`/`cr` query directly when troubleshooting.

## Persistent diagnostics

DevDash records structured **JSON Lines** in the data directory's
`logs\devdash.jsonl`. Logs survive process exits and are shared by CLI, native
messaging, watch, and library refresh operations. They never go to stdout or
into browser protocol frames.

```powershell
devdash logs path
devdash logs tail --lines 100
devdash logs tail --errors --lines 50
```

Records include UTC timestamps, application/Node versions, process/session IDs,
request and span correlation IDs, command/profile/provider, safe `queryName`
for named queries, cache hit/expiry and
lock phases, query/process phases, durations, counts, HTTP status or CLI exit
codes, and safe failure codes. Error responses include a `diagnosticId` that
matches log `requestId` (or the session ID for argument-parsing failures).
Native messaging requests get separate request IDs.
CLI failures also classify recognizable authentication, permission, rate-limit,
and invalid-query errors, retaining numeric HTTP status and Azure `TF` error
codes when present without retaining the original stderr.

For Chromium operations, DevDash passes a request UUID and a provider-specific
data directory to the separate `cr` process. Detailed browser/Gerrit phases are
logged in `logs\cr\logs\cr.jsonl`, with the same request UUID, while DevDash logs
the process and cache lifecycle. `devdash logs path` includes the `cr` home and
log file. To read those detailed records:

```powershell
$crHome = (devdash logs path | ConvertFrom-Json).providers.cr.home
cr logs tail --home $crHome --errors --lines 50
```

Standalone `cr` instead uses `CR_HOME` or `~\.cr`, with the same redaction,
rotation, and explicit logging-error policy. Child error codes are preserved;
DevDash never copies child error messages or raw stderr into its logs.

Logging uses an allowlist: **no full command arguments, query text, credentials,
environment dumps, raw provider stderr, exception messages/stacks, HTML,
screenshots, bug titles/descriptions, or comments are recorded**. Profile names
and public bug IDs are included for troubleshooting; treat the directory as
local diagnostic data. Config paths are hashed rather than recorded. Error
messages are intentionally excluded because third-party errors can contain
secrets. Use the phase plus safe code/status/exit code to locate the failure.

Logs rotate under an interprocess lock at 2 MiB per file and retain at most five
files (about 10 MiB). Archives are named `devdash.jsonl.1` through `.4`; tail
reads across them and filters for the selected configuration. Local restrictive
permissions are requested; on Windows, access follows the data directory's
inherited ACL. Retention is size-based, not time-based.

If diagnostics cannot be written, DevDash reports `LOG_WRITE_FAILED` rather
than silently claiming that logging worked. An operation whose completion
cannot be logged may already have persisted its data; check cache/profile
status after resolving disk-space or permission issues. Missing logs are empty;
damaged JSON records are explicit `INVALID_LOG` errors.

## Consumers

### PowerShell

Consume the grouped Edge profile as four independent lists. Exit `2` still
provides the grouped report, so check per-query errors before using a list:

```powershell
$json = devdash get edge
$exitCode = $LASTEXITCODE
if ($exitCode -notin 0, 2) { throw 'DevDash command failed' }
$result = $json | ConvertFrom-Json
if ($result.failed) {
    $result.queries.PSObject.Properties |
        Where-Object { $_.Value.error } |
        ForEach-Object { Write-Warning "$($_.Name): $($_.Value.error.message)" }
}
($result.queries.bugs.items) | Select-Object id, title, state, url
($result.queries.'security-bugs'.items) | Select-Object id, title, state, url
($result.queries.'my-prs'.items) | Select-Object id, title, state, url
($result.queries.'review-prs'.items) | Select-Object id, title, state, url
```

For one list, use `devdash get edge --query my-prs` and consume `$result.items`.
The existing flat-profile consumer also remains unchanged:

```powershell
$json = devdash get my-prs
if ($LASTEXITCODE -ne 0) { throw 'DevDash query failed' }
$result = $json | ConvertFrom-Json
$result.items | Select-Object id, title, state, url
```

For a scheduled refresh:

```powershell
$json = devdash refresh --all --due
if ($LASTEXITCODE -ne 0) { throw "DevDash refresh failed: $json" }
```

### Dragon pipelines

Run `devdash refresh --all --due` as a scheduled command and consume stdout as
JSON, checking the exit code. A separate step can run
`devdash get <profile> --cached-only` to consume the snapshot without a network
request. For the Edge dashboard, use `devdash get edge --cached-only` and map
`result.queries['bugs'].items`, `result.queries['security-bugs'].items`,
`result.queries['my-prs'].items`, and `result.queries['review-prs'].items` to
four separate output lists. Inspect `failed` and each entry's `error`; exit `2`
is a partial-failure report, not empty output. To consume only one list, run
`devdash get edge --query my-prs --cached-only` and read `result.items`.
Use the same OS user and `DEVDASH_HOME` as the other consumers. This
repository does not create or modify a Dragon pipeline automatically.

### Browser plugin: native messaging

Browsers cannot execute arbitrary CLIs. DevDash provides a **native messaging
host**, not a localhost web server. Register it for the existing Chrome/Edge
plugin's exact extension ID and add `"nativeMessaging"` to the plugin's
Manifest V3 permissions. Requests must originate from an extension page or
service worker, not directly from a content script.

On Windows, the CLI prepares a per-user launcher with an absolute
Node path, checkout-local `cr` discovery, and optional fixed home/config paths.
It registers only exact extension IDs for the selected browsers. Preview
the plan without changing files, dependencies, or the registry:

```powershell
devdash native install --browser both --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --preview
# Replace the example ID with your plugin's actual ID before installing.
devdash native install --browser both --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
devdash native status
devdash native extensions list
devdash native extensions add bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
devdash native extensions remove bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

Installation requires the full source checkout, including its workspace and
lockfile; the published npm package alone is not a native-host installation
source. `--extension-id` also accepts comma-separated IDs when development and
published extension IDs must both be allowed. `--install-directory` selects the generated
host files; its default is `%LOCALAPPDATA%\DevDash\NativeMessaging`.

`--home` and `--config` select trusted local paths at installation time; native
messages cannot override them. Installation requires Node 22 or later and
bootstraps missing checkout dependencies using `npm ci`; setup diagnostics go
to stderr. It does not install provider CLIs/browser binaries or authenticate.
Run `devdash doctor` or native `health` to check provider tools. Keep the
checkout at the registered path and rerun setup after moving it. Nothing is
registered automatically by `npm install`. To unregister:

```powershell
devdash native uninstall --browser both
```

All administration commands are **local CLI-only**; browser messages cannot
install hosts, edit the extension allowlist, or override launcher settings.
They use per-user HKCU registration for Chrome/Edge; no elevation is needed.
The host manifest has one shared `allowed_origins` list for both registered
browsers, using exact IDs with no wildcards. Install preserves existing IDs;
add/remove updates one ID without discarding the others. Installing with no
IDs or removing the final ID leaves an empty allowlist, allowing no extensions.
Development and store versions may have different IDs. Every allowed extension
can access the exposed DevDash protocol; the allowlist is not a per-profile ACL.

`native status` reports browser registrations and launcher health. List/status
and `--preview` do not write setup files or diagnostic logs. Mutations are
serialized, reject foreign registrations/unrecognized files, and restore prior
files and registration values if setup fails. A browser-specific uninstall
retains shared files while the other browser still references them. Use the same
`--install-directory` when managing a nondefault installation. The existing
`scripts\install-native-host.ps1` is now a thin compatibility wrapper around
these CLI commands; it no longer implements registry operations.

For manual registration, generate a manifest and register it **only when you
are ready to connect your plugin** (replace the extension ID):

```powershell
$extensionId = 'REPLACE-WITH-YOUR-32-CHARACTER-EXTENSION-ID'
$launcher = (Resolve-Path .\bin\devdash-native.cmd).Path
$manifest = Join-Path $env:LOCALAPPDATA 'DevDash\com.devdash.cli.json'
New-Item -ItemType Directory -Force (Split-Path $manifest) | Out-Null
$json = devdash native-manifest --extension-id $extensionId --launcher $launcher
if ($LASTEXITCODE -ne 0) { throw 'Invalid native host configuration' }
[System.IO.File]::WriteAllText($manifest, $json, [System.Text.UTF8Encoding]::new($false))

# Run the line for your browser (or both).
reg.exe ADD 'HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.devdash.cli' /ve /t REG_SZ /d $manifest /f
reg.exe ADD 'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.devdash.cli' /ve /t REG_SZ /d $manifest /f
```

The manual checkout launcher uses Node from PATH and ignores browser-supplied
origin/window arguments. Prefer the installer if Node is not on the browser's
inherited PATH. The launcher includes checkout-local `cr` on PATH; other provider
CLIs must be available to the native host for uncached queries.
Keep the checkout/package at the registered path.
To use a custom data directory, set a persistent `DEVDASH_HOME` before launching
the browser, or set it in your launcher. Nothing is registered by `npm install`
or `native-manifest` itself.

On Linux/macOS, register an executable launcher for `devdash-native` in the
browser's native-host manifest directory. See the browser's
[native messaging registration documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

Add this helper to your plugin's existing service worker and call it from an
async handler (report rejected promises through the plugin's usual error UI):

```javascript
async function getDevDash(profile) {
  const result = await chrome.runtime.sendNativeMessage('com.devdash.cli', {
    command: 'get',
    profile
  });
  if (result.error) throw new Error(result.error.message);
  return result;
}
```

Native requests are JSON objects. `hello` reports the application version,
capabilities, result fields, and transport limits without querying any provider.
`health` runs the CLI's dependency checks (`doctor`), not authentication or
interactive login. The existing commands remain backward compatible:
`profiles`, `get`, `refresh`, `status`, `profile-set`, and `profile-remove`.
Optional `profile`/`query` on `health` checks only selected query dependencies
(`devdash doctor dashboard --query bugs` in the CLI). Anonymous GitHub queries
do not require `gh`; the unscoped health check still inventories every tool.
Query commands accept `profile` **or** `all: true`;
`get` also accepts `cachedOnly: true`, or `cacheMode: "adaptive"` with optional
`fastQueryMs` (default 500), and `refresh` accepts `due: true`.
Adaptive mode and `cachedOnly` are mutually exclusive.
For `get`, `refresh`, and `status`, an optional `query` string selects one named
query when `profile` is supplied; it cannot be used with `all: true` or a flat
profile. For example, send:

```json
{ "command": "get", "profile": "edge", "cachedOnly": true }
```

Consume each list from `result.queries['bugs'].items`,
`result.queries['security-bugs'].items`, `result.queries['my-prs'].items`, and
`result.queries['review-prs'].items`. To request one flat query envelope instead:

```json
{ "command": "get", "profile": "edge", "query": "my-prs", "cachedOnly": true }
```

For an adaptive read that can refresh after the native connection closes:

```json
{ "command": "get", "profile": "edge", "query": "my-prs", "cacheMode": "adaptive", "fastQueryMs": 500 }
```

Responses have the same JSON shape as CLI results; check `failed` on grouped
profiles as well as batches, and each query's `error` before consuming it.
To configure a shared query from the plugin, send
`{ "command": "profile-set", "profile": "my-prs", "definition": { ... } }`,
where `definition` is the same validated flat or grouped profile object used
by the CLI. `profiles` and `profile-set` preserve grouped definitions unchanged.
`{ "command": "profile-remove", "profile": "my-prs" }` removes that profile and
its cache. Register only a trusted plugin: an allowed extension can read private
query results and manage profiles. The bridge does not permit arbitrary file
access, changing data paths, or launching arbitrary commands.

The protocol is UTF-8 JSON with a native-endian 32-bit length prefix. Incoming
and outgoing messages are bounded to 1 MiB; oversized results produce a
`MESSAGE_TOO_LARGE` error. Use `pageSize`/`fields` or select one query when
needed. Both one-shot `sendNativeMessage` and persistent `connectNative`
connections are supported.

#### Browser consumer contract

DevDash owns provider queries, authentication, and cache freshness. The
extension owns widget layout, sorting, display counts, and other presentation
preferences. Store a profile/query reference in each widget instead of a
second copy of its provider query or credentials. An optional browser snapshot
is only the last rendered view, not a second cache freshness policy. A widget
refresh interval of zero can disable the extension's automatic reads; do not
translate it to a zero `refreshSeconds` (cache lifetimes remain positive).

**No eventing or subscriptions are required or provided.** Read on page load
and at the extension's normal refresh interval. An adaptive read may return
cached data while the worker updates it; consume the new snapshot on the next
read. For long cold loads, start a detached job instead of holding a native
request open:

```json
{ "command": "refresh-start", "profile": "dashboard", "query": "bugs", "due": true }
```

For strictly non-blocking widget reads, combine `get` with `cachedOnly: true`
and `refresh-start` with `due: true`; timing-based adaptive reads are a latency
heuristic, not a hard foreground deadline.

The response contains `jobId`, `refreshStatus`, and cache status, not an empty
success-shaped result list. `due: true` skips fresh snapshots; omit it for a
manual forced reload. Read `status` for that profile/query when needed;
`backgroundRefresh` includes its `id`, state, timestamps, and a sanitized error
code on failure. States include `running`, `complete`, `failed`, and
`interrupted`. Check the job ID if another caller may have started newer work.
Then read `get` with `cachedOnly: true` to display the completed snapshot.
Provider errors preserve the last good cache. A job survives closing the native
connection; it does not depend on keeping a browser service worker alive.

`get` and `status` expose a `cacheRevision` for detecting snapshot changes.
Each provider has two cross-process query slots per configuration; grouped
reads preserve configured query order but run up to three independent queries
at a time. Excess provider work waits up to two minutes for a slot, then reports
`BUSY`. Per-query cache locks still deduplicate matching reads.

#### Safe named-query editing

Use the query operations for shared groups; replacing an entire group with
`profile-set` is unnecessary and can overwrite another consumer's definitions.

| Native command | Fields in addition to `command` |
| --- | --- |
| `query-get` | `profile`, `query` |
| `query-validate` | `profile`, `query`, `definition` |
| `query-set` | `profile`, `query`, `definition`, `expectedRevision` |
| `query-remove` | `profile`, `query`, `expectedRevision` |

`query-get` returns the saved `definition`, the inherited `effectiveDefinition`,
and its `revision`. Validation performs no save or provider request. Save with
that revision; use `"missing"` only when creating a query. Revisions cover the
target query and inherited defaults, but sibling edits do not conflict.
`REVISION_CONFLICT` requires rereading before another save, not an automatic
last-writer-wins retry. Existing standalone profiles are not implicitly converted.
The first query in a new group must include an explicit `refreshSeconds`.
Removing the final query also removes the now-empty group and its query cache.

CLI equivalents:

```powershell
devdash query validate dashboard bugs --file .\query.json
devdash query set dashboard bugs --file .\query.json --expected-revision missing
devdash query get dashboard bugs
# Use the returned revision for a later set/remove.
```

#### Paged reads, avatars, and request correlation

For one flat profile or selected named query, use a `pageSize` from 1 to 200
(default 50 when paging/projection is requested) and optional `fields`:

```json
{ "command": "get", "profile": "dashboard", "query": "bugs", "cachedOnly": true, "pageSize": 50, "fields": ["title", "state", "identities", "providerData"] }
```

`provider`, `kind`, `id`, and `url` are always retained. The response includes
`page.offset`, `page.size`, `page.total`, and `page.nextCursor`. Continue using
that cursor with the same profile/query, page size, and field projection.
Continuation reads are cache-only even if the request specifies another cache
policy; a cleared, invalidated, or replaced snapshot reports `CURSOR_EXPIRED`.
Restart without a cursor instead of mixing pages from different snapshots.
`page.total` counts cached matches; `truncated` still describes the provider
fetch limit, not whether another cached page exists. Pages shrink as needed
to stay within 768 KiB. A single oversized item requires a narrower projection.
CLI: `devdash get dashboard --query bugs --page-size 50 --fields title,state`.

Images are not embedded in each result row. Retrieve one identity avatar from
the current cache with:

```json
{ "command": "avatar", "profile": "dashboard", "query": "bugs", "itemId": "123", "role": "author" }
```

Roles are `author` (default), `assignee`, and `reviewer`; `index` selects an
assignee/reviewer, and optional `cacheRevision` protects against a changed
snapshot. The bridge accepts no caller-supplied image URL. Destinations must
match the selected provider scope; redirects, SVG, and images over 128 KiB
are rejected. Successful responses contain a raster `dataUrl`, `mimeType`,
and `fromCache`. Avatars are cached separately for six hours. ADO credentials
are obtained internally from the existing Azure CLI session or
`AZURE_DEVOPS_EXT_PAT`; neither credentials nor authenticated headers are sent
to the extension or persisted in avatar caches. Errors remain explicit so the
extension can show initials and its normal error details.
GitHub-origin avatars can use the existing `gh` credential internally; public
`avatars.githubusercontent.com` images never receive that credential.
For overlapping GitHub issue/PR numbers, include `"repository": "example/project"`
in the avatar request (CLI: `--repository example/project`). An ambiguous id alone
fails rather than selecting another repository's item. GitHub-origin avatar
credentials and avatar caches also respect the query's selected account.

On a persistent connection, optionally attach a unique ASCII `id` (1-80
letters/digits, `.`, `_`, `:`, or `-`) to each request. Responses are then
`{ "id": "...", "result": { ... } }` or `{ "id": "...", "error": { ... } }`.
Up to four correlated requests run concurrently and may reply out of order,
so a slow refresh does not block unrelated status/cache reads. Requests without
IDs retain the original sequential, unwrapped response shape. These are
request/reply messages only, never unsolicited events.

The richer provider contract uses a new cache fingerprint. Existing snapshots
are cache misses until refreshed; caches are not silently migrated or edited.

## Development

### Provider interface

`src\providers.js` registers independent adapters in `src\providers\` for
GitHub (`gh`), ADO (`az`), and Chromium (`cr`). Each implements the shared
`ProviderAdapter` contract:

```javascript
{
  id: 'chromium',
  cli: 'cr',
  resources: ['bugs', 'cls'],
  async query(profile, { runJson }) {
    // Return normalized items and an explicit truncation flag.
    return { items: [], truncated: false };
  }
}
```

The dispatcher resolves the effective limit, enforces supported resources and
the adapter's CLI, and validates normalized results before caching. Configuration,
cache/refresh orchestration, native messaging, and consumers remain
provider-independent. The `devdash/providers` export exposes `queryProfile`,
`providerRegistry`, and `createProviderRegistry`; tests can inject a registry
and JSON process runner without running real provider tools.
`devdash/filters` exports `filterProperties(profile)`, `compileFilter`, and
`filterItems` for discovering canonical fields/aliases and reusing the syntax.

Chromium's adapter crosses a real CLI process boundary, rather than importing
`cr`'s implementation. It validates `schemaVersion`, requested bug IDs, project
scope, counts, and normalized metadata. On Windows, npm's recognized `cr.cmd`
shim resolves to its Node entry point and is executed directly with
`shell: false`; query arguments are never interpolated through a command shell.
Browser batches have bounded timeouts scaled to the requested IDs.

```powershell
npm ci
npm test
npm run test:providers
npm test --workspace @devdash/cr
npm run coverage
npm run check:public
```

Tests use temporary data directories and fake provider responses; they do not
change your real DevDash configuration, CLI login, or browser registration.
Process-level tests cover JSON stdout/stderr, interprocess profile updates, the
native protocol, Chromium CLI adapters and npm shims, and the Windows native
launcher. The root suite also discovers the standalone `cr` tests; they use
fake browser/HTTP responses without browser downloads or live queries.
No transpiler or build step is needed.

### Test layers

| Layer | Command | Coverage / prerequisites |
| --- | --- | --- |
| Offline unit and integration suite | `npm test` | Filter/parser/schema tests, service/cache/races, logging, CLI/native subprocesses, and the provider suites. No auth or network required; live E2E is skipped |
| Provider unit tests | `npm run test:providers` | GitHub and ADO CLI argument/normalization/pagination fixtures, `cr` Gerrit HTTP fixtures and anonymous browser lifecycle fixtures |
| Reusable test provider | Included in `npm test` | `test\helpers\test-provider.js` uses the real registry/result contract with queued synthetic responses and explicit failures; no production provider or external CLI is registered |
| Live end-to-end | `npm run test:e2e -- --config <local-file>` | Real read-only provider requests through the CLI, filters, disk caches, offline cache/due reads, status/clear, and native messaging. Authenticate yourself first |

The live suite is opt-in and **does not run in GitHub Actions**. It never logs
in, stores tokens, changes provider authentication, creates remote issues/PRs,
or registers a browser native host. GitHub tests probe `gh api user` on the
configured host; ADO tests check the extension and project access using the
configured organization/project (existing `az login`, DevOps login, or PAT
environment authentication). Chromium queries use public anonymous access;
bug tests require the explicitly installed Playwright browser.

Prepare the tools and authenticate interactively as needed:

```powershell
npm ci
gh auth login
az extension add --name azure-devops
az login
# Alternatively, use your organization's normal az devops login/PAT flow.
npm exec --workspace @devdash/cr -- playwright install chromium --only-shell
Copy-Item .\examples\e2e.config.json .\devdash.e2e.local.json
# Edit only the ignored local copy. Replace ADO placeholders or remove providers
# you do not want to exercise; every query must have an explicit limit of 1-10.
npm run test:e2e -- --config .\devdash.e2e.local.json
```

Use a real authorized scope with safe, read-only queries. Empty result lists
are valid and still exercise transport/cache contracts. The example covers
GitHub bugs/PRs, ADO bugs/PRs, and public Chromium ID lookups, bug searches, and
CLs; removing a provider
reduces coverage, and the runner reports which provider/resources ran.
Configuration must have 1-10 profiles, at most 20 queries, and bounded limits.

The suite creates a unique temporary home outside the checkout and never uses
your normal DevDash configuration/cache. It substitutes generic test profile
and query names, checks clean JSON/stdout and framed native output, and removes
its configuration, cached results, and logs in `finally`, including on failure.
Failures suppress raw provider output, query text, result bodies, and private
scope values; reports contain only provider/resource names and pass/fail
information. Forced process termination can prevent cleanup; treat any leftover
`devdash-live-e2e-*` temporary directory as private and delete that exact directory
locally. Never upload it as a CI artifact or paste its contents into an issue.

### Public repository hygiene

All shipped organization/project/repository scopes are generic placeholders
or explicitly public resources. No real saved-query IDs, private bug/PR
contents, credentials, browser cookies, or authentication files belong in this
repository. Private profiles and live-test configuration belong outside the
checkout or in ignored local files. `.npmrc`, `.devdash`, `.cr`,
`*.e2e.local.json`, browser authentication state, reports, and traces are ignored.
Do not force-add them. Diagnostics intentionally exclude private result/query
contents; cached result files do not, so treat caches as private too.

`npm run check:public` examines tracked and nonignored candidate files for
recognizable credential patterns, organization-specific scopes/feed URLs, and
accidentally included local auth/test files. CI runs it alongside the offline
suite. The lockfile resolves dependencies from the public npm registry.
The check emits only file/category metadata, never matched values. Deliberately
synthetic credential-URL validation fixtures are allowed only in tests and only
for fixed dummy identities/passwords on `example.com` hosts.

This is a preventive hygiene check, **not a guarantee that arbitrary secrets
or private business data will be detected**. Review every diff before publishing,
and use GitHub secret scanning as another layer. Live E2E does not upload data
to any third-party reporting service.
