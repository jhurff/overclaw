# Theme packs

OverClaw paints every page from the active theme pack. Matrix is the default for a fresh install and for anyone with no saved preference.

Colors, fonts, borders, and shadows are CSS custom properties. Pages use those tokens, so a pack changes the swarm home, Project Tasks, Standing Tasks, and the rest of the dashboard together.

## Where packs live

Built-in packs ship in the repo:

```text
themes/<id>/theme.json
themes/<id>/extra.css    optional
```

Built-in packs are Matrix, USA, and Neutral. They cannot be deleted.

Imported packs are stored on the server, outside git, so a deploy (`git reset --hard`) keeps them:

```text
data/themes/<id>/theme.json
data/themes/<id>/extra.css    optional
```

The active theme id is saved in both places:

- `data/ui-settings.json` as `{ "activeThemeId": "matrix" }`
- the Brain database `app_settings` table, key `activeThemeId`, when `brain.db` is available

The browser also keeps the last applied CSS in `localStorage` under `overclaw-theme-pack` so the next paint can use it before the network responds. The server value is the source of truth across devices. A switch that has not finished saving is marked `overclaw-theme-pending` so a quick navigation does not flash the old pack.

Open Settings, then Themes (`/settings/themes`) to switch, reset to Matrix, import, or remove an imported pack.

## Pack format

`theme.json`:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | 1 to 40 characters. Lowercase letters, numbers, and hyphens. Must match the folder name for packs on disk. |
| `name` | yes | Plain text, 80 characters or fewer. |
| `description` | no | Plain text, 400 characters or fewer. |
| `tokens` | yes | Object of CSS custom properties. Names must look like `--oc-bg`. |
| `fonts` | no | `sans`, `display`, `mono` font stacks, and an optional `stylesheet`. |
| `effects` | no | Array. The only built-in effect is `digital-rain`. |
| `css` | no | Extra CSS. Also accepted as `extra.css` beside `theme.json` in a zip. |

Required tokens: `--oc-bg`, `--oc-text`, `--oc-accent`, `--oc-bg-card`, `--oc-border`, `--oc-theme-color`.

Any other `--oc-*` token you omit is filled from Matrix, so a small pack still covers heatmaps and status chips. Set the full list below if you do not want green leftovers.

Token values are colors, lengths, font stacks, and shadows. They cannot contain `url()`, `expression()`, `@import`, HTML, or `!important`.

Extra CSS is style rules only. These are rejected:

- `<script>` or any HTML tag
- `url(`, `@import`, `@font-face`, `@charset`
- `expression(`, `behavior`, `-moz-binding`
- unbalanced braces

A font stylesheet, when set, must be an `https://fonts.googleapis.com/css2` link. Anything else is rejected.

`effects` may include `digital-rain`. That draws a light canvas behind the page. It pauses when the visitor prefers reduced motion, when the tab is hidden, or when the battery is under 20 percent and not charging. The header Rain control pauses it by hand. The canvas stays dim so text stays readable.

## Zip import

A zip may contain only `theme.json` and an optional `extra.css`. Paths with `..` are rejected. The zip must store sizes in the local file header (the usual `zip` command does this). Encrypted zips and data-descriptor zips are rejected. Keep the zip under 200 KB.

## Tokens

Use these names in `tokens`. Pages read them as `var(--oc-...)`.

Backgrounds: `--oc-bg`, `--oc-bg-elevated`, `--oc-bg-sunken`, `--oc-bg-header`, `--oc-bg-sidebar`, `--oc-bg-card`, `--oc-bg-input`, `--oc-bg-code`, `--oc-bg-hover`, `--oc-overlay`

Text: `--oc-text`, `--oc-text-heading`, `--oc-text-muted`, `--oc-text-faint`, `--oc-text-inverse`, `--oc-text-on-accent`, `--oc-text-header`, `--oc-text-link`

Lines and accent: `--oc-border`, `--oc-border-strong`, `--oc-accent`, `--oc-accent-hover`, `--oc-accent-soft`, `--oc-accent-text`, `--oc-focus`, `--oc-stripe`

Status: `--oc-success`, `--oc-success-hover`, `--oc-success-soft`, `--oc-success-text`, and the same four suffixes for `--oc-warning`, `--oc-danger`, and `--oc-info`

Board columns: `--oc-status-inbox`, `--oc-status-inbox-text`, and the same pair for `progress`, `blocked`, `done`, and `scheduled`

Chrome: `--oc-shadow`, `--oc-shadow-lg`, `--oc-glow`, `--oc-radius`, `--oc-font-sans`, `--oc-font-display`, `--oc-font-mono`, `--oc-header-height`, `--oc-bottom-nav-height`, `--oc-theme-color`

Charts: `--oc-heat-0` through `--oc-heat-4`, `--oc-series-1` through `--oc-series-8`

`--oc-theme-color` is copied into the `theme-color` meta tag and the web app manifest.

## Built-in packs

- **Matrix** (default): black field, phosphor green (`#00ff41` family) monospace text, terminal panels, subtle glow, optional digital rain.
- **USA**: warm paper background, navy header, red accent, a stripe along the header, and a light star field in the sidebar.
- **Neutral**: plain light dashboard with no rain and no glow.

## Sample

[sample-theme.json](sample-theme.json) is a Harbor pack you can import from the Themes page or unzip into `data/themes/harbor/`. It is not installed until you import it. Change `id` before import if you want a different folder name. You cannot import over `matrix`, `usa`, or `neutral`.

## API

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/themes` | | `{ themes, active }` |
| GET | `/api/themes/active` | | active pack, including rendered `css` |
| POST | `/api/themes/active` | `{ "id": "usa" }` | switch and persist |
| POST | `/api/themes/reset` | | back to Matrix |
| POST | `/api/themes/import` | `{ "pack": { ... } }` or `{ "zipBase64": "..." }` | validate, store, return the pack |
| DELETE | `/api/themes/:id` | | remove an imported pack. Built-ins return an error. |

The Themes page is `/settings/themes`.
