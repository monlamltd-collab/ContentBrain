'use strict';

// Deterministic slot-fill ad assembler for AuctionBrain follower campaigns.
//
// The weak model (DeepSeek Flash via OpenRouter) only selects component IDs
// and fills typed slots. Final copy is assembled and validated HERE, in code.
// The model never writes final copy.
//
// Five gates, in order:
//   1. schema       — known IDs, slot completeness, slot values <= 80 chars
//   2. cta_platform — CTA must whitelist the target platform
//   3. length       — hard per-platform limits (config/platforms.json)
//   4. claims       — regex whitelist: only approved scale claims, no
//                     guarantees, no regulated language
//   5. dedup        — sha256(platform|hook|proofs|cta) vs 30-day publish log
//
// On failure: { ok: false, errors: [...] } plus buildRetryPrompt(errors) for
// the caller's retry loop (max 2 retries, then drop — caller's job).

const crypto = require('node:crypto');
const path = require('node:path');

const COMPONENTS = require(path.join(__dirname, '..', 'config', 'components.json'));
const PLATFORMS = require(path.join(__dirname, '..', 'config', 'platforms.json'));

const MAX_SLOT_CHARS = 80;
const MAX_PROOF_POINTS = 2;

const HOOKS = indexById(COMPONENTS.hooks);
const PROOF_POINTS = indexById(COMPONENTS.proof_points);
const CTAS = indexById(COMPONENTS.ctas);
const PLATFORM_IDS = Object.keys(PLATFORMS).filter((k) => k !== 'comment');

// Gate 4 patterns. Scale claims are matched then checked against the
// approved list; guarantee / regulated language is blocked outright.
const SCALE_CLAIM_RE = /(\d[\d,]*\s*\+?)\s*(?:uk\s+)?auction\s+houses?/gi;
const BLOCKED_PATTERNS = [
  { code: 'guarantee', re: /\b(guarantees?d?|risk[- ]?free|sure[- ]?thing|can(?:'|no)?t lose|assured (?:returns?|profits?))\b/i },
  { code: 'performance_claim', re: /\b\d{1,3}\s*%\s*(?:returns?|yields?|profits?|roi)\b/i },
  { code: 'regulated_language', re: /\b(fca|financial conduct authority|regulated|authorised|fscs)\b/i },
];

// Approved scale claims, normalised to their numeric token (e.g. "170+").
const APPROVED_SCALE_TOKENS = new Set(
  (COMPONENTS.approved_claims || [])
    .map((c) => {
      const m = new RegExp(SCALE_CLAIM_RE.source, 'i').exec(c.text);
      return m ? normaliseScaleToken(m[1]) : null;
    })
    .filter(Boolean)
);

function indexById(list) {
  const map = new Map();
  for (const item of list || []) map.set(item.id, item);
  return map;
}

function normaliseScaleToken(raw) {
  return raw.replace(/[\s,]/g, '');
}

function ensureSentenceTerminated(text) {
  const t = text.trim();
  if (t === '') return t;
  return /[.!?…]$/.test(t) ? t : t + '.';
}

function err(gate, code, message) {
  return { gate, code, message };
}

// ---------------------------------------------------------------------------
// Gate 1 — schema
// ---------------------------------------------------------------------------
function validateSchema(gen) {
  const errors = [];

  if (gen === null || typeof gen !== 'object' || Array.isArray(gen)) {
    return [err('schema', 'not_object', 'generation must be a JSON object')];
  }

  if (typeof gen.platform !== 'string' || !PLATFORM_IDS.includes(gen.platform)) {
    errors.push(err('schema', 'unknown_platform',
      `platform must be one of: ${PLATFORM_IDS.join(', ')}`));
  }

  const hook = typeof gen.hook_id === 'string' ? HOOKS.get(gen.hook_id) : undefined;
  if (!hook) {
    errors.push(err('schema', 'unknown_hook', `hook_id "${gen.hook_id}" is not in components.json`));
  }

  if (!Array.isArray(gen.proof_point_ids) || gen.proof_point_ids.length < 1) {
    errors.push(err('schema', 'proof_points_required', 'proof_point_ids must be an array of 1-2 known IDs'));
  } else {
    if (gen.proof_point_ids.length > MAX_PROOF_POINTS) {
      errors.push(err('schema', 'too_many_proof_points', `at most ${MAX_PROOF_POINTS} proof points`));
    }
    if (new Set(gen.proof_point_ids).size !== gen.proof_point_ids.length) {
      errors.push(err('schema', 'duplicate_proof_points', 'proof_point_ids must be unique'));
    }
    for (const id of gen.proof_point_ids) {
      if (!PROOF_POINTS.has(id)) {
        errors.push(err('schema', 'unknown_proof_point', `proof_point_id "${id}" is not in components.json`));
      }
    }
  }

  if (typeof gen.cta_id !== 'string' || !CTAS.has(gen.cta_id)) {
    errors.push(err('schema', 'unknown_cta', `cta_id "${gen.cta_id}" is not in components.json`));
  }

  // Slot completeness: exactly the hook's declared slots, no more, no less.
  const filled = gen.filled_slots;
  if (filled !== undefined && (filled === null || typeof filled !== 'object' || Array.isArray(filled))) {
    errors.push(err('schema', 'bad_filled_slots', 'filled_slots must be an object of slot_name -> string'));
  } else if (hook) {
    const provided = filled || {};
    for (const slot of hook.slots) {
      const value = provided[slot];
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(err('schema', 'missing_slot', `hook ${hook.id} requires slot "${slot}"`));
      } else if (value.trim().length > MAX_SLOT_CHARS) {
        errors.push(err('schema', 'slot_too_long', `slot "${slot}" exceeds ${MAX_SLOT_CHARS} chars`));
      }
    }
    for (const key of Object.keys(provided)) {
      if (!hook.slots.includes(key)) {
        errors.push(err('schema', 'unknown_slot', `slot "${key}" is not declared by hook ${hook.id}`));
      }
    }
  }

  // Headline: required on facebook, forbidden elsewhere.
  if (gen.platform === 'facebook') {
    if (typeof gen.headline !== 'string' || gen.headline.trim() === '') {
      errors.push(err('schema', 'headline_required', 'facebook generations must include a headline'));
    }
  } else if (gen.headline !== undefined && gen.headline !== null && gen.headline !== '') {
    errors.push(err('schema', 'headline_not_allowed', 'headline is facebook-only'));
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Assembly — hook (slots filled) + proof point(s) + CTA, sentence-terminated.
// ---------------------------------------------------------------------------
function fillSlots(template, filledSlots) {
  return template.replace(/\{([a-z0-9_]+)\}/gi, (_, name) => String(filledSlots[name]).trim());
}

function assemble(gen) {
  const hook = HOOKS.get(gen.hook_id);
  const parts = [ensureSentenceTerminated(fillSlots(hook.text, gen.filled_slots || {}))];
  for (const id of gen.proof_point_ids) {
    parts.push(ensureSentenceTerminated(PROOF_POINTS.get(id).text));
  }
  parts.push(ensureSentenceTerminated(CTAS.get(gen.cta_id).text));
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Gate 4 — claim whitelist
// ---------------------------------------------------------------------------
function validateClaims(text) {
  const errors = [];

  const scaleRe = new RegExp(SCALE_CLAIM_RE.source, 'gi');
  let m;
  while ((m = scaleRe.exec(text)) !== null) {
    const token = normaliseScaleToken(m[1]);
    if (!APPROVED_SCALE_TOKENS.has(token)) {
      errors.push(err('claims', 'unapproved_scale_claim',
        `"${m[0].trim()}" is not an approved claim (approved: ${[...APPROVED_SCALE_TOKENS].map((t) => `${t} auction houses`).join('; ')})`));
    }
  }

  for (const { code, re } of BLOCKED_PATTERNS) {
    const hit = re.exec(text);
    if (hit) {
      errors.push(err('claims', code, `blocked phrase: "${hit[0]}"`));
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Gate 5 — dedup key: sha256 of platform|hook|proofs(sorted)|cta
// ---------------------------------------------------------------------------
function computeDedupKey(gen) {
  const proofs = [...gen.proof_point_ids].sort().join(',');
  const raw = `${gen.platform}|${gen.hook_id}|${proofs}|${gen.cta_id}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// processGeneration(gen, publishedKeys) -> { ok, ad?, errors }
//   gen           — the weak model's JSON (see README for the contract)
//   publishedKeys — Set (or array) of dedup_key values from the last 30 days
// ---------------------------------------------------------------------------
function processGeneration(gen, publishedKeys) {
  const schemaErrors = validateSchema(gen);
  if (schemaErrors.length > 0) {
    return { ok: false, errors: schemaErrors };
  }

  const errors = [];

  // Gate 2 — CTA-platform whitelist
  const cta = CTAS.get(gen.cta_id);
  if (!cta.platforms.includes(gen.platform)) {
    errors.push(err('cta_platform', 'cta_platform_mismatch',
      `CTA ${cta.id} is whitelisted for [${cta.platforms.join(', ')}], not ${gen.platform}`));
  }

  // Gate 3 — hard length limits
  const primary = assemble(gen);
  const limits = PLATFORMS[gen.platform];
  if (primary.length > limits.primary_max) {
    errors.push(err('length', 'primary_too_long',
      `assembled copy is ${primary.length} chars; ${gen.platform} limit is ${limits.primary_max}`));
  }
  const headline = gen.platform === 'facebook' ? gen.headline.trim() : undefined;
  if (headline !== undefined && headline.length > limits.headline_max) {
    errors.push(err('length', 'headline_too_long',
      `headline is ${headline.length} chars; limit is ${limits.headline_max}`));
  }

  // Gate 4 — claim whitelist (run on the ASSEMBLED output, so slot fills are covered)
  errors.push(...validateClaims(headline ? `${headline} ${primary}` : primary));

  // Gate 5 — dedup vs 30-day publish log
  const dedupKey = computeDedupKey(gen);
  const seen = publishedKeys instanceof Set ? publishedKeys : new Set(publishedKeys || []);
  if (seen.has(dedupKey)) {
    errors.push(err('dedup', 'duplicate_creative',
      'this platform|hook|proofs|cta combination was published within the last 30 days'));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    ad: {
      platform: gen.platform,
      primary,
      ...(headline !== undefined ? { headline } : {}),
      dedup_key: dedupKey,
      components: {
        hook_id: gen.hook_id,
        proof_point_ids: [...gen.proof_point_ids],
        cta_id: gen.cta_id,
        filled_slots: { ...(gen.filled_slots || {}) },
      },
    },
  };
}

// Retry prompt for the weak model. Caller enforces max 2 retries, then drops.
function buildRetryPrompt(errors) {
  const lines = errors.map((e) => `- [${e.gate}/${e.code}] ${e.message}`);
  return [
    'Your previous ad generation was rejected by the validator. Fix every issue below and return a corrected JSON object in the exact same format. Only use component IDs that exist in the menu you were given.',
    ...lines,
  ].join('\n');
}

module.exports = {
  processGeneration,
  buildRetryPrompt,
  computeDedupKey,
  assemble,
  validateClaims,
  MAX_SLOT_CHARS,
  MAX_PROOF_POINTS,
};
