# Incident: Blog theme repeats + AuctionBrain content pipeline outage

**Date raised:** 2026-06-11
**Status:** Remediated (see checklist below)
**Affected systems:** AuctionBrain-Content, BridgeMatch-Content, ContentBrain review API, auctionbrain.co.uk blog

## Impact

- **bridgematch.co.uk blog** published near-duplicate posts on the same theme. The
  "BoE rate hold → bridging pricing" angle appeared **13 times in 30 days**
  (published 07/05, 28/05, 31/05, 02/06, 06/06; rejected by editor 09/05, 12/05,
  14/05, 22/05, 29/05, 04/06, 05/06, 08/06). Simon acted as a manual dedup filter
  via Telegram every morning.
- **auctionbrain.co.uk blog** received no new posts after **2026-05-19** (content
  starvation for 3+ weeks; daily SEO cadence broken).
- **10 AuctionBrain drafts stranded** in the wrong database (Bridgematch project),
  unreviewable: ContentBrain's approve/reject for `brand=auctionbrain` looks in the
  Auction.Bridgematch project and could not find them.
- **AuctionBrain-Content CI hard-failed daily** from 2026-06-02 onward (syntax
  error) — zero output, while Claude/Firecrawl spend continued on other repos.

## Timeline (verified from git, GitHub Actions, and live Supabase data)

| When | What |
|------|------|
| May 2026 | BoE rate-hold theme starts recurring on the BridgeMatch blog. Root cause: generators have no memory of unpublished work (see Cause 1/2). |
| 2026-05-19 | Last AuctionBrain post lands in the correct project (`pohrbfhftbprlfzsozyj`). |
| 2026-05-21 22:00 | `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` GitHub Actions secrets on **AuctionBrain-Content** are updated with the **Bridgematch** project's values (`omlsxojblgigenfuirbs`). First misplaced draft appears 22 minutes later. |
| 2026-05-21 → 06-01 | Daily AuctionBrain drafts (10 total) written into the Bridgematch DB with `brand='auctionbrain'` and auctionbrain.co.uk canonical URLs. None reviewable. |
| 2026-06-02 00:22 | Commit `455dad8` ("break blog topic repetition — anti-repeat rules") lands on AuctionBrain-Content master **with a syntax error** (raw newlines inside single-quoted `.join('` strings; mangled prompt text). Every run since crashes at import. The anti-repeat fix never executed, and was never ported to BridgeMatch-Content. |
| 2026-06-07 20:24 | ContentBrain commit `115e381` adds reactive theme dedup to `POST /api/review` (Jaccard ≥ 0.40 on titles, 45-day window, 409 response) plus `GET /api/review/recent-themes` for upstream avoidance. Neither generator adopted the upstream half; both ignore the 409. |
| 2026-06-06 → 06-10 | AuctionBrain-Content CI: 5 consecutive failures (SyntaxError). BridgeMatch BoE repeats continue (published 06-06; rejected 06-08). |
| 2026-06-11 | This incident consolidated and remediated. |

## Root causes

1. **Published-only theme memory (both engines).** `getPublishedPosts()` filters
   `status='published'`. Drafts awaiting review, approved-but-scheduled posts, and
   editor-rejected posts are invisible to theme selection. With daily generation and
   asynchronous human review, the engine re-picks yesterday's theme before yesterday's
   draft is reviewed. Editor rejections of a theme made it *more* likely to recur,
   not less (the rejected title vanished from memory entirely; only rejections with
   written feedback surfaced, and only in `generatePost`, not theme selection).
2. **BridgeMatch-Content had no title memory at all.** Its `selectTheme` received
   only per-cluster post *counts*. Within a cluster (e.g. `rates-and-market`), nothing
   discouraged the same angle repeating forever.
3. **The AuctionBrain anti-repeat fix was dead on arrival.** Commit `455dad8`
   contained literal newlines inside single-quoted strings (`.join('` … `')`) —
   `SyntaxError: Invalid or unexpected token` on import — and the selectTheme prompt
   lost IDENTIFICATION RULES 1–5 in a bad paste. CI red since 2026-06-02.
4. **Wrong Supabase project in AuctionBrain-Content CI secrets** (since 2026-05-21
   22:00). Posts, scraped articles, and source state all went to the Bridgematch
   project. The landing site and ContentBrain's `brand=auctionbrain` client read the
   Auction.Bridgematch project, so output was stranded and unreviewable.
5. **The ContentBrain 409 gate was too narrow and unhandled.**
   - The 45-day comparison set excluded `rejected` posts — exactly the titles Simon
     was rejecting as repeats — so a re-roll of a rejected theme passed the gate.
   - No brand filter: cross-brand contamination in the comparison set once both
     brands' rows shared a table.
   - Generators logged the 409 and moved on: the duplicate draft stayed in
     `blog_posts` (rotting unreviewed), its source articles already consumed via
     `used_in_post`, and the day's content slot was wasted.
   - Title Jaccard at 0.40 misses thematic repeats with different headlines: the
     published BoE pairs measure ~0.22 against each other. Title similarity is a
     backstop, not a theme detector — prevention has to happen generator-side.

## Remediation (implemented 2026-06-11)

- [x] **AuctionBrain-Content** — fix `lib/generator.js` syntax errors and reconstruct
  the selectTheme prompt (coverage wording, rules 1–7 including the anti-repetition
  rule). CI green again.
- [x] **Both engines** — new `getRecentPostTitles(daysBack=45)` in `lib/db.js`:
  fetches titles across `draft`, `approved`, `published`, **and `rejected`** statuses
  (brand-scoped, legacy NULL brand included). Injected into `selectTheme` as a
  "RECENT POSTS — do not repeat" block with an explicit anti-repetition rule.
- [x] **Both engines** — `sendForReview` now returns the outcome; on HTTP 409
  (`theme_duplicate`) the engine marks the just-saved draft `rejected` with
  `revision_feedback` set to the dedup message. The repeat feeds the existing
  rejection-learning loop instead of rotting as an orphan draft.
- [x] **ContentBrain** — `getRecentBlogPostTitles` now includes `rejected` posts and
  filters by brand (NULL-brand legacy rows treated as same-brand).
- [x] **Ops** — AuctionBrain-Content GitHub secrets repointed to
  `pohrbfhftbprlfzsozyj` (values verified against the project ref in the key's JWT).
- [x] **Data repair** — the 10 stranded `brand='auctionbrain'` drafts in the
  Bridgematch project marked `rejected` with explanatory `revision_feedback`
  (stale news from May; the fixed pipeline regenerates fresh content in the right DB).

## Not done (future work)

- **Semantic theme matching.** Title Jaccard cannot see that "BoE Rate Hold Sparks
  Debt Market Volatility" and "Bank of England Rate Hold Creates Bridging Finance
  Pricing Volatility" are the same story. If repeats persist despite generator-side
  memory, move the gate to embeddings or entity/topic signatures.
- **Cross-stream pre-flight.** `GET /api/review/recent-themes` exists for generators
  to query before writing (covers Reddit-brief promotions and any future content
  sources). Engines currently rely on their own DB, which is equivalent today.
- **auctionbrain.co.uk/blog returns 404** (checked 2026-06-11). May be a routing or
  path issue on the landing site — investigate separately; not caused by this incident.

## Verification

- `npm test` green in AuctionBrain-Content, BridgeMatch-Content, ContentBrain.
- `node -c lib/generator.js` clean in both engines.
- Manual `workflow_dispatch` of AuctionBrain-Content generates a draft in the
  **correct** project and a Telegram review card without crashing.
- Live check: BoE-themed resubmission now 409s against the rejected set, and the
  engine records the rejection instead of stranding a draft.
