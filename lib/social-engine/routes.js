// Phase G-3 — Make boost integration Express route handlers.
//
// Extracted out of server.js so the three callback routes can be unit-
// tested without booting the full app. server.js mounts them with
// express.raw middleware (HMAC needs the raw body bytes verbatim).
//
//   POST /api/social-boost-callback   — Route A — lifecycle status from Make
//   POST /api/social-boost-reconcile  — Route B — daily metrics batch from Make
//   GET  /api/social-boost-active     — Route C — Make pulls active runs
//
// Signature carriers:
//   A + B  — x-make-signature (Make signs WITH MAKE_CALLBACK_SECRET)
//   C      — x-cb-signature (Make signs WITH MAKE_WEBHOOK_SECRET) or
//            ?sig= query-string fallback
//
// See .ruflo/phase-g3-design.md §3.4 for full contract.

'use strict';

const { verifyInbound, verifyOutbound } = require('./webhook-auth');

function classifyError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/signature|verification/i.test(msg)) return { status: 401, msg };
  return { status: 500, msg };
}

/**
 * Route A — POST /api/social-boost-callback.
 *
 * @param {object} req  express req — req.body must be a Buffer (raw)
 * @param {object} res  express res
 * @param {object} deps  { markBoostActive, markBoostFailed } — injectable
 */
async function handleBoostCallback(req, res, deps) {
  try {
    verifyInbound(req.body, req.headers);
    const payload = JSON.parse(req.body.toString('utf8'));
    const { request_id, status, boost_campaign_id, boost_ad_id, started_at, error_message } = payload;
    if (!request_id) return res.status(400).json({ error: 'request_id required' });

    if (status === 'active') {
      const row = await deps.markBoostActive(request_id, { boost_campaign_id, boost_ad_id, started_at });
      return res.status(200).json({ ok: true, status: row.status });
    }
    if (status === 'failed') {
      const row = await deps.markBoostFailed(request_id, error_message || 'Make scenario reported failed');
      return res.status(200).json({ ok: true, status: row.status });
    }
    return res.status(400).json({ error: `unknown status: ${status}` });
  } catch (err) {
    const { status, msg } = classifyError(err);
    if (status === 401) console.warn(`[POST /api/social-boost-callback] 401: ${msg}`);
    else console.error(`[POST /api/social-boost-callback] 500: ${msg}`);
    return res.status(status).json({ error: msg });
  }
}

/**
 * Route B — POST /api/social-boost-reconcile.
 *
 * Per-row errors are caught + returned in the response but do NOT abort
 * the batch (per phase-g3-design §5 — Make's execution log captures rows).
 *
 * @param {object} req
 * @param {object} res
 * @param {object} deps  { markBoostMetrics }
 */
async function handleBoostReconcile(req, res, deps) {
  try {
    verifyInbound(req.body, req.headers);
    const { as_of, metrics } = JSON.parse(req.body.toString('utf8'));
    if (!Array.isArray(metrics)) return res.status(400).json({ error: 'metrics array required' });

    const results = [];
    for (const m of metrics) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const row = await deps.markBoostMetrics(m.boost_campaign_id, { ...m, as_of });
        results.push({ campaign: m.boost_campaign_id, ok: true, status: row.status });
      } catch (rowErr) {
        const rmsg = rowErr && rowErr.message ? rowErr.message : String(rowErr);
        console.warn(`[POST /api/social-boost-reconcile] row ${m.boost_campaign_id} failed: ${rmsg}`);
        results.push({ campaign: m.boost_campaign_id, ok: false, error: rmsg });
      }
    }
    return res.status(200).json({ ok: true, processed: results.length, results });
  } catch (err) {
    const { status, msg } = classifyError(err);
    if (status === 401) console.warn(`[POST /api/social-boost-reconcile] 401: ${msg}`);
    else console.error(`[POST /api/social-boost-reconcile] 500: ${msg}`);
    return res.status(status).json({ error: msg });
  }
}

/**
 * Route C — GET /api/social-boost-active.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} deps  { supabase }
 */
async function handleBoostActive(req, res, deps) {
  try {
    const body = req.body && req.body.length ? req.body : Buffer.alloc(0);
    verifyOutbound(body, req.headers, req.query && req.query.sig);

    const { data, error } = await deps.supabase
      .from('boost_runs')
      .select('id, boost_campaign_id, status, started_at, duration_hours')
      .in('status', ['pending', 'active'])
      .not('boost_campaign_id', 'is', null)
      .order('started_at', { ascending: false });
    if (error) throw new Error(error.message);

    return res.status(200).json({
      runs: (data || []).map(r => ({
        request_id: r.id,
        boost_campaign_id: r.boost_campaign_id,
        status: r.status,
        started_at: r.started_at,
        duration_hours: r.duration_hours,
      })),
    });
  } catch (err) {
    const { status, msg } = classifyError(err);
    if (status === 401) console.warn(`[GET /api/social-boost-active] 401: ${msg}`);
    else console.error(`[GET /api/social-boost-active] 500: ${msg}`);
    return res.status(status).json({ error: msg });
  }
}

module.exports = { handleBoostCallback, handleBoostReconcile, handleBoostActive };
