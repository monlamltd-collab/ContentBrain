# growth-brain-ads

Deterministic slot-fill ad pipeline for AuctionBrain follower campaigns.

**Design principle:** the weak model (DeepSeek Flash via OpenRouter) only selects
component IDs and fills typed slots. Final copy is assembled and validated in
code — the model never writes final copy. A weekly DeepSeek V4 full call proposes
new components; Simon reviews and commits.

`config/components.json` is a **pinned contract**: changes via PR only.

## Layout

```
config/components.json   hooks, proof_points, ctas, personas, approved_claims
config/platforms.json    hard per-platform length limits
lib/adAssembler.js       processGeneration(gen, publishedKeys) — the 5 gates
lib/publishLog.js        30-day dedup_key loader (Supabase)
test/adAssembler.test.js 7 tests, plain node, no deps
../migrations/020-posts-dedup-key.sql            DRAFT — not applied
```

Run tests from the repo root:

```
node growth-brain-ads/test/adAssembler.test.js
```

(Not picked up by `npm test` — that glob only covers `tests/**`. Port to
`node:test` and move under `tests/` if you want it in the suite.)

## Model contract

DeepSeek Flash must return exactly:

```json
{
  "platform": "facebook|instagram|instagram_reels|x|linkedin",
  "hook_id": "H1",
  "proof_point_ids": ["P1"],
  "cta_id": "C1",
  "filled_slots": { "tedious_activity": "..." },
  "headline": "..."
}
```

- `proof_point_ids`: 1–2 entries, unique, known IDs.
- `filled_slots`: exactly the slots the chosen hook declares; each value ≤ 80 chars.
- `headline`: facebook only (required there, ≤ 40 chars); forbidden elsewhere.

## The five gates

1. **schema** — known platform/hook/proof/CTA IDs, slot completeness, slot length.
2. **cta_platform** — the CTA's `platforms` whitelist must include the target platform.
3. **length** — assembled copy vs `platforms.json` hard limits (FB 125/40, X 280, IG 2200, LI 3000).
4. **claims** — regex on the *assembled* output (so slot fills are covered):
   only the approved scale claim ("170+ auction houses") may appear; guarantees,
   %-return promises and regulated language (FCA/regulated/authorised/FSCS) are blocked.
5. **dedup** — `sha256(platform|hook_id|proofs sorted|cta_id)` vs the 30-day publish log.

Assembly: hook (slots filled) + proof point(s) + CTA, each sentence-terminated,
joined with single spaces.

On failure, `processGeneration` returns `{ ok: false, errors: [...] }`;
`buildRetryPrompt(errors)` turns that into the retry message for the model.
**Max 2 retries, then drop** — the retry loop belongs to the caller (see sketch below).

## Publish log integration

Publish log = `public.posts` in Supabase project **Auction.Bridgematch**
(`pohrbfhftbprlfzsozyj`). Brand filter `auctionbrain`, statuses draft/published/rejected.

1. Apply `migrations/020-posts-dedup-key.sql` (adds nullable `dedup_key text`
   + partial index). **Draft — Simon signs off before applying.**
2. Load the window and run the pipeline (uses the repo's shared client):

```js
const { supabase } = require('../lib/supabase');
const { loadPublishedDedupKeys } = require('./lib/publishLog');
const { processGeneration } = require('./lib/adAssembler');

const publishedKeys = await loadPublishedDedupKeys(supabase); // Set<string>
const result = processGeneration(generationFromModel, publishedKeys);
```

3. On `ok: true`, insert into `posts` with `status='draft'`, `brand='auctionbrain'`,
   `platform`, `copy_body = ad.primary`, `copy_headline = ad.headline`,
   `dedup_key = ad.dedup_key`, and the component IDs + slots in `meta` for audit.
   The dedup window covers pending (unrejected, unpublished) rows by default so
   two identical creatives can't sit in the approval queue together.

## Make-facing endpoint — SKETCH ONLY (not built)

Follows the existing Make→CB webhook convention (`/api/social-boost-callback`
et al.: `express.raw` body, HMAC via `MAKE_WEBHOOK_SECRET`, `x-cb-signature`
header or `?sig=`, handler in a lib module).

```
Make scenario (e.g. daily 'AuctionBrain — generate ad')
  1. Schedule trigger
  2. HTTP → OpenRouter chat/completions (DeepSeek Flash, response_format json_object)
       system prompt = contract above + component menu rendered from components.json
  3. HTTP POST → POST /api/growth-ads-assemble   (HMAC-signed, x-cb-signature)
       body: the model's raw JSON string
  4. Router on response:
       200 → done (post row already inserted as draft for the approval flow)
       422 → loop back to step 2 with retry_prompt appended as a user message
             (Make repeater, max 2 cycles), then drop + log
```

Endpoint behaviour (route mounted in server.js, handler in
`growth-brain-ads/lib/routes.js` when built):

```js
// POST /api/growth-ads-assemble
// 1. verifyInbound (same webhook-auth as the social-boost routes)
// 2. parse body JSON (tolerate the model wrapping it in markdown fences)
// 3. publishedKeys = await loadPublishedDedupKeys(supabase)
// 4. result = processGeneration(gen, publishedKeys)
// 5. ok    → insertPost({ brand: 'auctionbrain', platform, template_type: 'growth_ad',
//            status: 'draft', copy_body: ad.primary, copy_headline: ad.headline,
//            dedup_key: ad.dedup_key, meta: ad.components })
//            → 200 { ok: true, post_id, dedup_key }
// 6. !ok   → 422 { ok: false, errors, retry_prompt: buildRetryPrompt(errors) }
//            attempt counting stays in Make (scenario state), so the endpoint
//            stays stateless
```

Alternative (no HTTP at all): a `workers/`-style script on node-cron, like the
existing generate/publish workers — but Make-side retry routing favours the
endpoint. Decision open.

## Weekly component proposal (DeepSeek V4)

Weekly full call gets: components.json + last 30 days of post_metrics.
It proposes new hooks/proofs/CTAs as a JSON patch. Output goes to a PR against
`config/components.json` — never merged automatically. Gate 4's approved-claims
list is part of the same file, so new claims also arrive by PR.
