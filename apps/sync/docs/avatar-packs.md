# Avatar packs

Agent avatars in the desktop shell come from **packs**: versioned catalogs of
images the picker can browse. There will be many packs. A pack is a static
host that serves `pack.json` plus the images it names.

## Manifest (`pack.json`)

```json
{
  "id": "hq-agent-mascots",
  "name": "HQ agent mascots",
  "version": "1.0.0",
  "author": "Lizzy",
  "baseUrl": "https://hq-agent-mascots.indigo-hq.com",
  "items": [
    {
      "id": "v2-dot",
      "name": "Dot · simplified",
      "src": "mascots/v2/dot.png",
      "tags": ["v2", "simplified", "rabbit", "generalist", "mascot"]
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Stable slug. Used as the selection key with `items[].id`. |
| `name` | yes | Pack heading in the picker. |
| `version` | yes | Opaque string. Displayed; not compared. |
| `author` | yes | Credit line. |
| `baseUrl` | yes | Origin the pack was loaded from. Relative `src` values resolve against it. |
| `items[].id` | yes | Unique within the pack. |
| `items[].name` | yes | Searchable label. |
| `items[].src` | yes | Relative path or absolute `http(s)` URL. |
| `items[].tags` | no | Searchable keywords. Missing / non-array becomes `[]`. |

Unknown fields are ignored. Duplicate item ids, empty required strings, or a
non-`http(s)` absolute `src` fail validation and the pack is skipped.

## Loading

For each registered pack URL the shell:

1. Fetches `${baseUrl}/pack.json` with credentialed `fetch` (so HQ-gated
   hosts that already issued an `hq-access` cookie work).
2. Validates the body.
3. On network / parse / validation failure, uses a bundled snapshot when one
   exists for that `baseUrl`.

The first remote pack is Lizzy's mascot catalog at
`https://hq-agent-mascots.indigo-hq.com/`. Its snapshot lives at
`packages/ui/src/avatars/packs/hq-agent-mascots.json`. The live site did not
ship `pack.json` when this landed; the snapshot is the working catalog until
it does.

A built-in pack, **Generated marks**, is always loaded from the bundled
`agent-NN.png` set. It is not a URL and cannot be removed.

## Adding a pack

Settings → General → Avatar packs. Paste the pack's base URL (the directory
that serves `pack.json`) and add it. Remove the URL to drop the pack. The
next picker open reloads the registry.

Default registry:

- `builtin:generated-marks` (always present, not listed as removable)
- `https://hq-agent-mascots.indigo-hq.com`

## Saving a choice

The picker uploads the chosen image through `PATCH /v1/agents/{uid}/profile`
as `avatarBase64` (JPEG/PNG, ≤192KB). hq-pro does not accept an external URL
for the avatar; the bytes are the source of truth. After a successful save
the shell refreshes channel rosters and the contacts list so the rail, thread,
and DM header pick up the new photo.

Only company owners/admins see the picker. Everyone else gets the read-only
profile.

## hq-pro companion

Agent photos already ride `entity.metadata.agentConfig.profile` and are
presigned onto `GET /v1/channels/{id}/members` as `avatarUrl`. A companion
hq-pro change adds `avatarUrl` on `GET /v1/notify/contacts` so agent DMs that
never shared a channel still show the assigned photo.
