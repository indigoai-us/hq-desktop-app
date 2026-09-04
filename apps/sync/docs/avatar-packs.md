# Avatar packs

Agent avatars in the desktop shell come from **packs**. Generated marks stay
bundled in the app. Catalog packs (Animals, and any later publisher packs)
live on hq-pro and are fetched on demand.

## Server gallery

hq-pro stores pack images in the same private marketplace-assets bucket used
for profile avatars (`avatar-packs/{id}/…`). The desktop picker talks to:

| Method | Route | Purpose |
|---|---|---|
| GET | `/v1/avatar-packs` | List packs: id, name, author `{handle, displayName, avatarUrl?}`, version, count, thumbnailUrl |
| GET | `/v1/avatar-packs/{id}` | Items: id, name, tags, thumbUrl (~128px, presigned), fullUrl (presigned) |
| POST | `/v1/agents/{uid}/avatar` | `{ packId, itemId }` — server copies the pack image onto the agent's `avatarKey` |

All three are JWT-authenticated. The packaged CSP allowlists the production
marketplace-assets host, so presigned thumbs paint in `<img>` tags. Responses
include `expiresAt`; the shell caches the list + details in memory and
`localStorage` until then.

## Built-in Default pack

**Generated marks** (credit line **Default**) still load from the bundled
`packages/ui/src/assets/agent-avatars/agent-NN.jpg` set (512px JPEG). Those
files are small and stay client-side. Item `src` values are Vite asset URLs
from `import.meta.glob` — they must not be joined onto the
`builtin:generated-marks` base. Choosing "Use generated mark" still PATCHes
`/v1/agents/{uid}/profile` with `avatarBase64`.

## Animals

Lizzy's mascot catalog is the first remote pack. Display name **Animals**.
Publish it from hq-pro:

```bash
HQ_API_BASE=https://<api> HQ_ACCESS_TOKEN=<jwt> \
  npx tsx scripts/publish-avatar-pack.ts scripts/avatar-packs/animals
```

The folder is `pack.json` plus the image files it names. HQ staff or a
verified marketplace creator may publish. Follow-up POSTs add more items to
the same pack id.

## Loading

On picker open the shell:

1. Shows a skeleton grid.
2. Calls `GET /v1/avatar-packs`, then `GET /v1/avatar-packs/{id}` for each pack,
   through the authenticated adapter (web, Tauri, Sync).
3. Reuses the cached payload while `expiresAt` is in the future.
4. Lazy-loads tile images (`loading="lazy"`). A tile whose image fails to
   decode shows a two-letter mark instead of an empty square.

Empty catalog and fetch errors have their own copy. Search still filters by
name, id, and tags.

## Saving a choice

- **Generated mark** — download the bundled JPEG, PATCH profile `avatarBase64`.
- **Pack item** — `POST /v1/agents/{uid}/avatar` `{ packId, itemId }`. hq-pro
  copies the stored pack object onto `agents/{uid}/{hash}.{ext}` (the same
  field the upload path writes) and returns `avatarUrl`.

After a successful save the shell refreshes channel rosters and the contacts
list so the rail, thread, and DM header pick up the new photo.

Only company owners/admins see the picker. Everyone else gets the read-only
profile.

## Migration from bundled snapshots

The desktop app no longer ships mascot images under
`packages/ui/src/avatars/packs/`. A source-contract test fails the build if
binary images return there (that is how v0.10.181 blew the 120 MB macOS
universal binary budget: Vite embeds globbed snapshots in the JS dist, and
Tauri packs that dist into **each** architecture slice). The pack-URL
registry setting is gone; packs come from hq-pro, not pasted hosts.

Generated marks stay bundled and remain under a size gate so they cannot
quietly grow the binary the same way.

## hq-pro companion

Agent photos ride `entity.metadata.agentConfig.profile.avatarKey` and are
presigned onto channel members and contacts as `avatarUrl`.
