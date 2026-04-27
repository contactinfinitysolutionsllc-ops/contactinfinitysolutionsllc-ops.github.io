// Copyright 2025 Infinity Solutions LLC. All Rights Reserved.
// Cloudflare Worker — Infinity Solutions API
// Deploy at: dash.cloudflare.com → Workers & Pages → justdocs-worker
//
// Environment variables (Worker Settings → Variables → Environment Variables):
//   ANTHROPIC_API_KEY      — from console.anthropic.com
//   SUPABASE_URL           — https://zcvkgevcrgsujnqovxgd.supabase.co
//   SUPABASE_KEY           — your service role key (NOT the anon/publishable key)
//   RESEND_API_KEY         — from resend.com (for email notifications)
//   SQUARE_ACCESS_TOKEN    — from developer.squareup.com → your app → Production credentials
//   SQUARE_LOCATION_ID     — from Square dashboard → Account & Settings → Business locations
//   SQUARE_WEBHOOK_SECRET  — from Square Developer → Webhooks → your endpoint → Signature key
//
// KV Namespace binding (Worker Settings → Variables → KV Namespace Bindings):
//   RATE_LIMIT_KV — create namespace at: Cloudflare Dashboard → Workers & Pages → KV
//                   Name it "RATE_LIMIT_KV", then bind it to this worker as "RATE_LIMIT_KV"
//
// Rate limiting design:
//   Free users   (no email passed): 5 AI calls / IP / calendar month
//   Subscribers  (email passed):  500 AI calls / email / calendar month (fair use)
//   Burst limit  (all users):      10 AI calls / IP / minute (in-memory, prevents flooding)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── ROUTE GROUPS ──────────────────────────────────────────────────────────────
// All actions handled directly in this worker — no Apps Script dependency
const CONTRACTOR_ACTIONS = [
  'submitProject',        // Homeowner submits a project
  'onboardContractor',    // Contractor submits application after payment
  'getContractorProfile', // Public contractor profile lookup
  'searchContractors',    // Homeowner browses contractors by category/location
  'acceptMatch',          // Contractor accepts a job offer
  'declineMatch',         // Contractor declines a job offer
  'getMyMatches',         // Contractor sees their pending matches
  'getMyProjects',        // Homeowner sees their submitted projects
  'submitReview',         // Either party submits a review
  'getReviews',           // Get reviews for a contractor
  'scoreProject',         // AI scores a project submission for quality
  // squareWebhook handled separately — detected by square-signature header in fetch()
  'recordAgreement',      // Store a digital signature / agreement acceptance
  'markComplete',         // Mark a project as completed, trigger review request
  'reportIncomplete',     // Homeowner reports job abandoned/incomplete — re-route to new contractor
  'getContractorBadges',  // Get earned badges for a contractor
  'checkSubscriber',      // Check if email has active AI tools subscription
  'addSubscriber',        // Add/activate a subscription
  'cancelSubscriber',     // Cancel a subscription
];

// ── BURST RATE LIMIT (in-memory, per-minute) ─────────────────────────────────
// Prevents flooding — resets on worker restart but sufficient for burst protection
const burstStore = new Map();

function checkBurstLimit(ip, action) {
  const now    = Date.now();
  const window = 60 * 1000; // 1 minute
  const limits = {
    submitProject:    5,
    claude:           10,
    createPaymentLink: 5,
    onboardContractor: 3,
    default:          20,
  };
  const limit = limits[action] || limits.default;
  const key   = `${ip}:${action}`;
  const entry = burstStore.get(key);

  if (!entry || now > entry.resetAt) {
    burstStore.set(key, { count: 1, resetAt: now + window });
    return { allowed: true };
  }
  if (entry.count >= limit) {
    return { allowed: false, resetIn: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true };
}

function cleanBurstStore() {
  const now = Date.now();
  for (const [key, entry] of burstStore.entries()) {
    if (now > entry.resetAt) burstStore.delete(key);
  }
}

// ── MONTHLY USAGE TRACKING (Cloudflare KV) ────────────────────────────────────
// Persistent across worker restarts — survives localStorage clears, incognito, device changes
// Free users tracked by IP  (5 calls/month)
// Subscribers tracked by email (500 calls/month — fair use)
//
// KV key format:  free:{ip}:{YYYY-MM}   or   sub:{email}:{YYYY-MM}
// TTL: 40 days — auto-purges after the month rolls over

function getMonthStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTHLY_LIMITS = { free: 5, subscriber: 500 };

async function checkMonthlyUsage(env, identifier, type) {
  if (!env.RATE_LIMIT_KV) return { allowed: true, remaining: 999, degraded: true };
  const limit = MONTHLY_LIMITS[type] ?? MONTHLY_LIMITS.free;
  const key   = `${type === 'subscriber' ? 'sub' : 'free'}:${identifier}:${getMonthStamp()}`;
  const count = parseInt(await env.RATE_LIMIT_KV.get(key) || '0', 10);
  if (count >= limit) return { allowed: false, count, limit, remaining: 0 };
  return { allowed: true, count, limit, remaining: limit - count - 1 };
}

async function incrementMonthlyUsage(env, identifier, type) {
  if (!env.RATE_LIMIT_KV) return;
  const key   = `${type === 'subscriber' ? 'sub' : 'free'}:${identifier}:${getMonthStamp()}`;
  const count = parseInt(await env.RATE_LIMIT_KV.get(key) || '0', 10);
  // 40-day TTL — expires well after month end, then auto-purges
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 40 * 24 * 60 * 60 });
}

// ── ACTIVATE / RENEW SUBSCRIPTION IN SUPABASE ────────────────────────────────
// Single source of truth for expiry — used by addSubscriber AND webhook handler.
// Grace buffer: monthly = 35 days, annual = 370 days (handles billing cycle variance)
async function activateSubscription(env, email, plan, squareSubId, squareCustomerId) {
  const now = Date.now();
  let expiresMs;
  if      (plan === 'session')    expiresMs = now + 24  * 60 * 60 * 1000;
  else if (plan === 'annual')     expiresMs = now + 370 * 24 * 60 * 60 * 1000;
  else                            expiresMs = now + 35  * 24 * 60 * 60 * 1000; // monthly / contractor

  const expires_at = new Date(expiresMs).toISOString();
  await sb(env, '/subscriptions', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      email,
      plan:               plan || 'monthly',
      status:             'active',
      square_sub_id:      squareSubId      || null,
      square_customer_id: squareCustomerId || null,
      expires_at,
      activated_at:       new Date().toISOString(),
      updated_at:         new Date().toISOString()
    })
  });
  return expires_at;
}

// ── SQUARE WEBHOOK SIGNATURE VERIFICATION ────────────────────────────────────
async function verifySquareSignature(rawBody, signature, webhookUrl, sigKey) {
  try {
    const encoder   = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw', encoder.encode(sigKey),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const hashBuffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(webhookUrl + rawBody));
    const hashBase64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
    return hashBase64 === signature;
  } catch { return false; }
}

// ── SQUARE WEBHOOK HANDLER ────────────────────────────────────────────────────
// Detected in fetch() by presence of square-signature header.
// Handles: payment.updated (activation + renewals), subscription.updated (cancellations/status changes)
async function handleSquareWebhook(request, env) {
  const rawBody   = await request.text();
  const sigHeader = request.headers.get('square-signature') || '';
  const WEBHOOK_URL = 'https://justdocs-worker.robertjosephreynolds.workers.dev';

  // Verify signature — reject spoofed requests
  if (env.SQUARE_WEBHOOK_SECRET) {
    const valid = await verifySquareSignature(rawBody, sigHeader, WEBHOOK_URL, env.SQUARE_WEBHOOK_SECRET);
    if (!valid) return new Response('Unauthorized', { status: 401 });
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return new Response('OK', { status: 200 }); } // malformed — ack and ignore

  const type = event.type || '';
  const obj  = event.data?.object;

  try {
    // payment.updated — fires on first payment and every auto-renewal ───────
    if (type === 'payment.updated' || type === 'payment.completed') {
      const payment      = obj?.payment;
      const status       = payment?.status || '';
      // Only act on completed payments — ignore pending/failed
      if (status === 'COMPLETED') {
        const email        = payment?.buyer_email_address?.toLowerCase().trim();
        const amountCents  = payment?.amount_money?.amount || 0;
        const squareSubId  = payment?.subscription_id || null;
        const squareCustId = payment?.customer_id     || null;

        if (email) {
          // Determine plan from payment amount
          let plan = 'monthly';
          if      (amountCents <= 99)   plan = 'session';
          else if (amountCents >= 9900) plan = 'annual';
          else if (amountCents >= 4900) plan = 'contractor'; // $49
          // $12 = 1200 cents → monthly (default)

          await activateSubscription(env, email, plan, squareSubId, squareCustId);
        }
      }
    }

    // subscription.updated — handles activations, cancellations, pauses ────
    if (type === 'subscription.updated' || type === 'subscription.deactivated') {
      const sub    = obj?.subscription;
      const status = sub?.status || '';
      if (sub?.id) {
        const subId = encodeURIComponent(sub.id);
        if (status === 'DEACTIVATED' || status === 'CANCELED' || status === 'CANCELLED' || type === 'subscription.deactivated') {
          // Cancel Hub subscription record
          await sb(env, `/subscriptions?square_sub_id=eq.${subId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              status:       'cancelled',
              cancelled_at: new Date().toISOString(),
              updated_at:   new Date().toISOString()
            })
          });
          // Deactivate contractor if this was a contractor subscription
          await sb(env, `/contractors?subscription_id=eq.${subId}`, {
            method: 'PATCH',
            body: JSON.stringify({ active_subscription: false })
          }).catch(() => {});
        }
        // ACTIVE status — payment.updated handles expiry extension on renewals
      }
    }

  } catch(e) {
    console.error('Webhook processing error:', e.message);
    // Still return 200 — non-200 causes Square to retry, creating duplicates
  }

  return new Response('OK', { status: 200 });
}

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    // ── SQUARE WEBHOOK (detected before JSON parse — needs raw body) ─────
    if (request.headers.get('square-signature')) {
      return handleSquareWebhook(request, env);
    }

    // ── GET CLIENT IP ─────────────────────────────────────────────────────
    const ip = request.headers.get('CF-Connecting-IP') ||
               request.headers.get('X-Forwarded-For') ||
               'unknown';

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const action = body.action || body.endpoint || '';

    // ── BURST RATE LIMIT CHECK ────────────────────────────────────────────
    const burstCheck = checkBurstLimit(ip, action);
    if (!burstCheck.allowed) {
      return json({
        error: 'Too many requests — please slow down',
        retry_after: burstCheck.resetIn
      }, 429);
    }

    // Clean burst store occasionally (roughly 1% of requests)
    if (Math.random() < 0.01) cleanBurstStore();

    // ── DIRECT AI ROUTE (with monthly usage tracking) ─────────────────────
    if (action === 'claude') {
      const email      = (body.email || '').toLowerCase().trim();
      const usageType  = email ? 'subscriber' : 'free';
      const identifier = email || ip;
      const usage = await checkMonthlyUsage(env, identifier, usageType);
      if (!usage.allowed) {
        return json({
          error: usageType === 'subscriber'
            ? `Monthly fair-use limit reached (${usage.limit} AI generations). Resets next month.`
            : 'Free monthly limit reached. Subscribe to continue.',
          limitReached: true,
          limitType: usageType
        }, 429);
      }
      incrementMonthlyUsage(env, identifier, usageType).catch(() => {});
      return handleClaude(body, env);
    }

    // ── DIRECT PAYMENT LINK ROUTE ─────────────────────────────────────────
    if (action === 'createPaymentLink') {
      return handleCreatePaymentLink(body, env);
    }

    // ── CONTRACTOR PLATFORM ROUTES ────────────────────────────────────────
    if (CONTRACTOR_ACTIONS.includes(action)) {
      return handleContractorAction(action, body, env, request);
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  }
};

// ── DIRECT CLAUDE AI HANDLER ─────────────────────────────────────────────────
async function handleClaude(body, env) {
  const { prompt, system } = body;
  if (!prompt) return json({ error: 'prompt required' }, 400);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI not configured' }, 500);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-opus-4-5',
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (data.error) return json({ error: data.error.message }, 500);
    const result = data.content?.[0]?.text || '';
    return json({ result });
  } catch (err) {
    return json({ error: 'AI call failed: ' + err.message }, 500);
  }
}

// ── DIRECT SQUARE PAYMENT LINK HANDLER ──────────────────────────────────────
async function handleCreatePaymentLink(body, env) {
  const { docType, amount, redirectUrl } = body;
  if (!amount || !docType) return json({ error: 'amount and docType required' }, 400);
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) {
    return json({ error: 'Payment not configured' }, 500);
  }
  try {
    const r = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization':  'Bearer ' + env.SQUARE_ACCESS_TOKEN,
        'Content-Type':   'application/json'
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        quick_pay: {
          name:         docType,
          price_money:  { amount: Math.round(amount * 100), currency: 'USD' },
          location_id:  env.SQUARE_LOCATION_ID
        },
        checkout_options: {
          redirect_url: redirectUrl || 'https://infinityhub.dev'
        }
      })
    });
    const data = await r.json();
    if (data.errors?.length) {
      return json({ error: data.errors[0]?.detail || 'Square error' }, 400);
    }
    return json({ url: data.payment_link?.url });
  } catch (err) {
    return json({ error: 'Payment link failed: ' + err.message }, 500);
  }
}

// ── SUPABASE HELPER ──────────────────────────────────────────────────────────
async function sb(env, path, options = {}) {
  const url = env.SUPABASE_URL + '/rest/v1' + path;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  try {
    return { data: JSON.parse(text), status: res.status };
  } catch {
    return { data: text, status: res.status };
  }
}

// ── EMAIL HELPER (Resend) ────────────────────────────────────────────────────
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return; // skip if not configured yet
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'InfinityMatch <noreply@infinityhub.dev>',
      to,
      subject,
      html
    })
  }).catch(() => {}); // fire and forget, don't let email failure break the flow
}

// ── CONTRACTOR ACTION ROUTER ─────────────────────────────────────────────────

// ── BADGE SYSTEM ─────────────────────────────────────────────────────────────
function computeBadges(contractor) {
  const badges = [];
  const now = new Date();
  const joinDate = contractor.created_at ? new Date(contractor.created_at) : now;
  const monthsActive = (now - joinDate) / (1000 * 60 * 60 * 24 * 30);
  const rating = parseFloat(contractor.rating) || 0;
  const jobs = parseInt(contractor.jobs_completed) || 0;
  const responseRate = parseFloat(contractor.response_rate) || 0;

  // Verified Pro — passed license/insurance check
  if (contractor.verified) {
    badges.push({ id: 'verified_pro', label: 'Verified Pro',
      icon: '✓', color: 'green',
      desc: 'License and insurance verified by InfinityMatch' });
  }

  // Top Rated — 4.8+ with 5+ reviews
  if (rating >= 4.8 && jobs >= 5) {
    badges.push({ id: 'top_rated', label: 'Top Rated',
      icon: '⭐', color: 'gold',
      desc: 'Maintained a 4.8+ rating across 5 or more completed jobs' });
  } else if (rating >= 4.5 && jobs >= 3) {
    badges.push({ id: 'highly_rated', label: 'Highly Rated',
      icon: '★', color: 'gold',
      desc: 'Consistently excellent reviews from homeowners' });
  }

  // Quick Responder — 90%+ response rate
  if (responseRate >= 90 && jobs >= 3) {
    badges.push({ id: 'quick_responder', label: 'Quick Responder',
      icon: '⚡', color: 'blue',
      desc: 'Responds to match requests within 2 hours, 90%+ of the time' });
  }

  // Job milestones
  if (jobs >= 100) {
    badges.push({ id: 'jobs_100', label: '100 Jobs', icon: '💯', color: 'purple',
      desc: 'Completed 100 jobs through InfinityMatch' });
  } else if (jobs >= 50) {
    badges.push({ id: 'jobs_50', label: '50 Jobs', icon: '🔨', color: 'blue',
      desc: 'Completed 50 jobs through InfinityMatch' });
  } else if (jobs >= 10) {
    badges.push({ id: 'jobs_10', label: '10 Jobs', icon: '🏗️', color: 'teal',
      desc: 'Completed 10 jobs through InfinityMatch' });
  } else if (jobs >= 1) {
    badges.push({ id: 'first_job', label: 'First Job', icon: '🎯', color: 'teal',
      desc: 'Completed their first job through InfinityMatch' });
  }

  // Tenure badges
  if (monthsActive >= 24) {
    badges.push({ id: 'tenure_2yr', label: '2 Year Pro', icon: '🏆', color: 'gold',
      desc: 'Active InfinityMatch member for 2+ years' });
  } else if (monthsActive >= 12) {
    badges.push({ id: 'tenure_1yr', label: '1 Year Strong', icon: '📅', color: 'blue',
      desc: 'Active InfinityMatch member for 1+ year' });
  } else if (monthsActive >= 3) {
    badges.push({ id: 'tenure_3mo', label: 'Established', icon: '📌', color: 'gray',
      desc: 'Active on InfinityMatch for 3+ months' });
  }

  return badges;
}

async function recalculateBadges(env, contractor_id) {
  try {
    const { data: c } = await sb(env,
      `/contractors?id=eq.${contractor_id}&select=rating,jobs_completed,verified,created_at,response_rate`
    );
    if (!c?.[0]) return;
    const badges = computeBadges(c[0]);
    await sb(env, `/contractors?id=eq.${contractor_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ badges: JSON.stringify(badges) })
    });
  } catch(e) {}
}

async function handleContractorAction(action, body, env, request) {
  try {
    switch (action) {

      // ── HOMEOWNER: Submit a project ───────────────────────────────────────
      case 'submitProject': {
        const { homeowner_name, homeowner_email, homeowner_phone,
                title, description, category, zip_code, state,
                budget_range, timeline } = body;

        if (!homeowner_email || !title || !description || !category || !zip_code) {
          return json({ error: 'Missing required fields' }, 400);
        }

        // ── DUPLICATE CHECK ───────────────────────────────────────────────
        // Block same email + same category within 24 hours
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: existing } = await sb(env,
          `/projects?homeowner_email=eq.${encodeURIComponent(homeowner_email)}&category=eq.${encodeURIComponent(category)}&created_at=gt.${cutoff}&status=neq.cancelled`
        );
        if (existing?.length > 0) {
          return json({
            success: false,
            duplicate: true,
            message: 'You already submitted a similar project recently. Check your email for updates on your existing submission.'
          }, 200);
        }

        // AI quality score — direct Anthropic call
        let quality_score = 50; // default
        try {
          if (env.ANTHROPIC_API_KEY) {
            const scoreRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'x-api-key':         env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json'
              },
              body: JSON.stringify({
                model:      'claude-haiku-4-5-20251001',
                max_tokens: 100,
                system: 'You are a fraud detection AI for a contractor marketplace. Score project submissions based on: specificity of description, realistic scope, complete contact info, and signs of fake/spam submissions. Return only valid JSON.',
                messages: [{ role: 'user', content:
                  `Rate this contractor project submission for quality and legitimacy on a scale of 0-100.
Return ONLY a JSON object like: {"score": 85, "reason": "brief reason"}

Title: ${title}
Description: ${description}
Category: ${category}
Location: ${zip_code}, ${state}
Budget: ${budget_range || 'not specified'}`
                }]
              })
            });
            if (scoreRes.ok) {
              const scoreData = await scoreRes.json();
              const parsed = JSON.parse(scoreData.content?.[0]?.text || '{}');
              quality_score = parsed.score || 50;
            }
          }
        } catch (e) {}

        // Hold low quality submissions for manual review
        const status = quality_score < 30 ? 'flagged' : 'pending';

        const { data, status: dbStatus } = await sb(env,
          '/projects',
          {
            method: 'POST',
            body: JSON.stringify({
              homeowner_name, homeowner_email, homeowner_phone,
              title, description, category, zip_code, state,
              budget_range, timeline, quality_score, status
            })
          }
        );

        if (dbStatus !== 201) {
          return json({ error: 'Failed to submit project', detail: data }, 500);
        }

        const project = Array.isArray(data) ? data[0] : data;

        // Trigger matching if quality is good enough
        if (status === 'pending') {
          await matchProject(project, env);
        }

        // ── AI COST ESTIMATE ─────────────────────────────────────────────
        let estimate = null;
        try {
          if (env.ANTHROPIC_API_KEY) {
            const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'x-api-key': env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
              },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                messages: [{ role: 'user', content:
                  `You estimate contractor job costs in New England. Give a realistic market-rate range.
Job: ${title}
Category: ${category}
Details: ${description.slice(0,300)}
Location: ${zip_code}, ${state}
Timeline: ${timeline || 'flexible'}

Reply ONLY with JSON: {"low":number,"high":number,"notes":"one sentence"}`
                }]
              })
            });
            if (aiRes.ok) {
              const aiData = await aiRes.json();
              const raw = aiData?.content?.[0]?.text || '';
              estimate = JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g, '').trim());
            }
          }
        } catch(e) { /* estimate failed — not fatal */ }

        return json({
          success: true,
          project_id: project.id,
          estimate,
          message: status === 'flagged'
            ? 'Your project has been submitted and is under review.'
            : 'Your project has been submitted. A contractor will reach out shortly.'
        });
      }

      // ── CONTRACTOR ONBOARDING after Square payment ───────────────────────────
      case 'onboardContractor': {
        const { name, email, user_id, biz_name, phone, categories, zip_code, state,
                radius, bio, license_num, license_state,
                ins_carrier, ins_policy } = body;

        if (!email || !biz_name) return json({ error: 'Missing required fields' }, 400);

        // Create contractor record — pending verification
        const { data, status: dbStatus } = await sb(env, '/contractors', {
          method: 'POST',
          body: JSON.stringify({
            name:                  name || email.split('@')[0],
            email,
            user_id:               user_id || null,
            phone:                 phone || '',
            business_name:         biz_name,
            license_number:        license_num || '',
            license_state:         license_state || state,
            license_status:        license_num ? 'pending' : 'manual_review',
            insurance_status:      body.coi_file_b64 ? 'pending' : 'manual_review',
            active_subscription:   true,
            verified:              false,
            categories,
            service_radius_miles:  parseInt(radius) || 25,
            zip_code,
            state,
            bio:                   bio || '',
          })
        });

        if (dbStatus !== 201) {
          return json({ error: 'Failed to create contractor record', detail: data }, 500);
        }

        const contractor = Array.isArray(data) ? data[0] : data;

        // Create verification records for admin review
        if (license_num || body.license_file_b64) {
          await sb(env, '/verifications', {
            method: 'POST',
            body: JSON.stringify({
              contractor_id: contractor.id,
              type:          'license',
              status:        'pending',
              notes:         [
                license_num ? `License #: ${license_num}` : '',
                license_state ? `State: ${license_state}` : '',
                body.license_file_b64 ? 'Document uploaded' : 'No document — number only',
              ].filter(Boolean).join(' · ')
            })
          });
        }

        if (body.coi_file_b64) {
          await sb(env, '/verifications', {
            method: 'POST',
            body: JSON.stringify({
              contractor_id: contractor.id,
              type:          'insurance',
              status:        'pending',
              notes:         [
                ins_carrier ? `Carrier: ${ins_carrier}` : '',
                ins_policy  ? `Policy: ${ins_policy}`  : '',
                'COI document uploaded',
              ].filter(Boolean).join(' · ')
            })
          });
        }

        // Notify admin
        await sendEmail(env,
          'contact.infinitysolutionsllc@gmail.com',
          `New contractor application: ${biz_name}`,
          `<p>New contractor onboarded and awaiting verification:</p>
           <p><strong>Name:</strong> ${name}<br>
           <strong>Business:</strong> ${biz_name}<br>
           <strong>Email:</strong> ${email}<br>
           <strong>Trades:</strong> ${categories}<br>
           <strong>Location:</strong> ${zip_code}, ${state}<br>
           <strong>License:</strong> ${license_num || 'Document only'}<br>
           <strong>COI:</strong> ${body.coi_file_b64 ? 'Uploaded' : 'Not provided'}</p>
           <p>Log into Supabase to review verifications table.</p>`
        );

        return json({ success: true, contractor_id: contractor.id });
      }

      // ── MATCH A PROJECT TO CONTRACTORS ────────────────────────────────────
      // Also called by Cron trigger for expired matches
      case 'scoreProject': {
        const { project_id } = body;
        const { data: projects } = await sb(env, `/projects?id=eq.${project_id}`);
        const project = projects?.[0];
        if (!project) return json({ error: 'Project not found' }, 404);
        const matched = await matchProject(project, env);
        return json({ success: true, matched });
      }

      // ── CONTRACTOR: Accept a match ─────────────────────────────────────────
      case 'acceptMatch': {
        const { match_id, contractor_id } = body;
        if (!match_id || !contractor_id) return json({ error: 'Missing fields' }, 400);

        // Update match status
        await sb(env, `/matches?id=eq.${match_id}&contractor_id=eq.${contractor_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'accepted', responded_at: new Date().toISOString() })
        });

        // Get project details to notify homeowner
        const { data: matches } = await sb(env, `/matches?id=eq.${match_id}`);
        const match = matches?.[0];
        if (match?.project_id) {
          const { data: projects } = await sb(env, `/projects?id=eq.${match.project_id}`);
          const project = projects?.[0];
          const { data: contractors } = await sb(env, `/contractors?id=eq.${contractor_id}`);
          const contractor = contractors?.[0];

          if (project && contractor) {
            // Update project as matched
            await sb(env, `/projects?id=eq.${match.project_id}`, {
              method: 'PATCH',
              body: JSON.stringify({
                status: 'matched',
                assigned_contractor_id: contractor_id,
                assigned_at: new Date().toISOString()
              })
            });

            // Email homeowner
            await sendEmail(env,
              project.homeowner_email,
              'A contractor has accepted your project!',
              `<p>Hi ${project.homeowner_name},</p>
               <p><strong>${contractor.business_name || contractor.name}</strong> has accepted your project: <em>${project.title}</em>.</p>
               <p>They will contact you at ${project.homeowner_phone || project.homeowner_email} to schedule.</p>
               <p>Contact: ${contractor.phone || contractor.email}</p>
               <br><p>— InfinityMatch</p>`
            );
          }
        }

        return json({ success: true, message: 'Match accepted' });
      }

      // ── CONTRACTOR: Decline a match ────────────────────────────────────────
      case 'declineMatch': {
        const { match_id, contractor_id, decline_reason, decline_notes } = body;
        if (!match_id || !contractor_id) return json({ error: 'Missing fields' }, 400);

        await sb(env, `/matches?id=eq.${match_id}&contractor_id=eq.${contractor_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'declined', responded_at: new Date().toISOString() })
        });

        // Try to find next contractor for this project
        const { data: matches } = await sb(env, `/matches?id=eq.${match_id}`);
        const match = matches?.[0];
        if (match?.project_id) {
          const { data: projects } = await sb(env, `/projects?id=eq.${match.project_id}`);
          if (projects?.[0]?.status === 'pending') {
            await matchProject(projects[0], env, contractor_id); // exclude this contractor
          }
        }

        return json({ success: true });
      }

      // ── CONTRACTOR: Get their matches ──────────────────────────────────────
      case 'getMyMatches': {
        const { contractor_id } = body;
        if (!contractor_id) return json({ error: 'Missing contractor_id' }, 400);

        const { data: matches } = await sb(env,
          `/matches?contractor_id=eq.${contractor_id}&status=eq.offered&expires_at=gt.${new Date().toISOString()}&select=*,projects(*)`
        );
        return json({ matches: matches || [] });
      }

      // ── HOMEOWNER: Get their projects ──────────────────────────────────────
      case 'getMyProjects': {
        const { email } = body;
        if (!email) return json({ error: 'Missing email' }, 400);
        const { data: projects } = await sb(env,
          `/projects?homeowner_email=eq.${encodeURIComponent(email)}&order=created_at.desc`
        );
        return json({ projects: projects || [] });
      }

      // ── PUBLIC: Get contractor profile ────────────────────────────────────
      case 'getContractorProfile': {
        const { contractor_id } = body;
        if (!contractor_id) return json({ error: 'Missing contractor_id' }, 400);
        const { data: contractors } = await sb(env,
          `/contractors?id=eq.${contractor_id}&verified=eq.true`
        );
        const contractor = contractors?.[0];
        if (!contractor) return json({ error: 'Contractor not found' }, 404);
        // Don't expose sensitive fields
        const { user_id, subscription_id, license_number, ...publicProfile } = contractor;
        return json({ contractor: publicProfile });
      }

      // ── PUBLIC: Search contractors ────────────────────────────────────────
      case 'searchContractors': {
        const { category, state, zip_code } = body;
        let query = '/contractors?verified=eq.true&active_subscription=eq.true';
        if (state)    query += `&state=eq.${encodeURIComponent(state)}`;
        if (category) query += `&categories=like.*${encodeURIComponent(category)}*`;
        query += '&order=rating.desc&limit=20';
        const { data: contractors } = await sb(env, query);
        // Strip sensitive fields
        const safe = (contractors || []).map(({ user_id, subscription_id, license_number, ...c }) => c);
        return json({ contractors: safe });
      }

      // ── SUBMIT A REVIEW ───────────────────────────────────────────────────
      case 'submitReview': {
        const { project_id, contractor_id, reviewer_type, rating, comment } = body;
        if (!project_id || !contractor_id || !rating) {
          return json({ error: 'Missing required fields' }, 400);
        }
        if (rating < 1 || rating > 5) return json({ error: 'Rating must be 1-5' }, 400);

        const { data, status: dbStatus } = await sb(env, '/reviews', {
          method: 'POST',
          body: JSON.stringify({ project_id, contractor_id, reviewer_type, rating, comment })
        });

        if (dbStatus === 201) {
          // Recalculate contractor average rating
          const { data: reviews } = await sb(env,
            `/reviews?contractor_id=eq.${contractor_id}&select=rating`
          );
          if (reviews?.length > 0) {
            const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
            await sb(env, `/contractors?id=eq.${contractor_id}`, {
              method: 'PATCH',
              body: JSON.stringify({ rating: Math.round(avg * 10) / 10 })
            });
          }
        }

        return json({ success: dbStatus === 201 });
      }

      // ── GET REVIEWS for a contractor ──────────────────────────────────────
      case 'getReviews': {
        const { contractor_id } = body;
        if (!contractor_id) return json({ error: 'Missing contractor_id' }, 400);
        const { data: reviews } = await sb(env,
          `/reviews?contractor_id=eq.${contractor_id}&reviewer_type=eq.homeowner&order=created_at.desc&limit=20`
        );
        return json({ reviews: reviews || [] });
      }



      // ── REPORT INCOMPLETE JOB — re-route to new contractor ──────────
      case 'reportIncomplete': {
        const { project_id, homeowner_email, reason } = body;
        if (!project_id) return json({ error: 'Missing project_id' }, 400);

        // Get the project
        const { data: projData } = await sb(env, `/projects?id=eq.${project_id}`);
        const project = projData?.[0];
        if (!project) return json({ error: 'Project not found' }, 404);

        // Get the contractor who abandoned it
        const abandonedContractorId = project.assigned_contractor_id;

        // Reset project for re-matching
        await sb(env, `/projects?id=eq.${project_id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'pending',
            assigned_contractor_id: null,
            assigned_at: null,
            incomplete_reason: reason || 'Job not completed',
            previously_assigned: abandonedContractorId,
            requeue_count: (project.requeue_count || 0) + 1
          })
        });

        // Flag contractor who abandoned job
        if (abandonedContractorId) {
          const { data: cData } = await sb(env,
            `/contractors?id=eq.${abandonedContractorId}&select=abandoned_jobs`
          );
          const abandonedCount = (cData?.[0]?.abandoned_jobs || 0) + 1;
          await sb(env, `/contractors?id=eq.${abandonedContractorId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              abandoned_jobs: abandonedCount,
              // Auto-suspend if 3+ abandoned jobs
              active_subscription: abandonedCount >= 3 ? false : undefined
            })
          });
        }

        // Re-trigger matching, excluding the contractor who abandoned
        const matchResult = await matchProject(
          { ...project, status: 'pending', assigned_contractor_id: null },
          env,
          abandonedContractorId  // exclude from re-match
        );

        // Email homeowner
        if (homeowner_email) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.RESEND_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'InfinityMatch <noreply@infinityhub.dev>',
              to: homeowner_email,
              subject: matchResult.matched
                ? 'Good news — we found a new contractor for your project'
                : "We're finding a new contractor for your project",
              html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:2rem">
                <h2>We're on it</h2>
                <p>We're sorry your previous contractor didn't complete the job. We've reported this issue and are finding you a replacement.</p>
                ${matchResult.matched
                  ? '<p style="color:green;font-weight:bold">✓ A new contractor has been notified and will reach out shortly.</p>'
                  : "<p>We are searching for an available contractor in your area. You will hear from us soon.</p>"
                }
                <p style="font-size:.8rem;color:#999">InfinityMatch · <a href="https://infinityhub.dev">infinityhub.dev</a></p>
              </div>`
            })
          }).catch(() => {});
        }

        return json({
          success: true,
          re_matched: matchResult.matched || false,
          message: matchResult.matched
            ? 'Job re-routed to a new contractor'
            : 'Job re-queued — searching for available contractor'
        });
      }

      // ── MARK PROJECT COMPLETE + TRIGGER REVIEW REQUEST ───────────────
      case 'markComplete': {
        const { project_id, contractor_id, homeowner_email, homeowner_name,
                contractor_name, project_description } = body;

        if (!project_id || !contractor_id) {
          return json({ error: 'Missing project_id or contractor_id' }, 400);
        }

        // Update project status to completed
        await sb(env, `/projects?id=eq.${project_id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'completed',
            completed_at: new Date().toISOString()
          })
        });

        // Update contractor jobs_completed count
        const { data: cData } = await sb(env,
          `/contractors?id=eq.${contractor_id}&select=jobs_completed`
        );
        const currentJobs = cData?.[0]?.jobs_completed || 0;
        await sb(env, `/contractors?id=eq.${contractor_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ jobs_completed: currentJobs + 1 })
        });

        // Send review request to homeowner via Resend (24-hour delay simulated by sending now)
        // In production you'd use a scheduled queue — for MVP send immediately
        if (homeowner_email) {
          const reviewUrl = `https://contactinfinitysolutionsllc-ops.github.io/review/?project=${project_id}&contractor=${contractor_id}`;
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.RESEND_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: 'InfinityMatch <noreply@infinityhub.dev>',
              to: homeowner_email,
              subject: 'How did your project go? Leave a review',
              html: `
                <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:2rem">
                  <h2 style="color:#1a1a2e">How did it go?</h2>
                  <p>Hi ${homeowner_name || 'there'},</p>
                  <p>Your project <strong>${project_description || 'with InfinityMatch'}</strong>
                  has been marked as complete by <strong>${contractor_name || 'your contractor'}</strong>.</p>
                  <p>Your review helps other homeowners find great contractors and helps good contractors
                  build their reputation. It only takes 30 seconds.</p>
                  <div style="text-align:center;margin:2rem 0">
                    <a href="${reviewUrl}" style="background:#4f8eff;color:#fff;padding:.8rem 2rem;
                    border-radius:8px;text-decoration:none;font-weight:600;font-size:1rem">
                      ⭐ Leave a Review
                    </a>
                  </div>
                  <p style="font-size:.8rem;color:#999">
                    InfinityMatch · <a href="https://infinityhub.dev" style="color:#4f8eff">infinityhub.dev</a>
                  </p>
                </div>`
            })
          }).catch(() => {}); // non-fatal
        }

        // Recalculate badges after job completion
        await recalculateBadges(env, contractor_id);

        return json({ success: true, jobs_completed: currentJobs + 1 });
      }

      // ── GET CONTRACTOR BADGES ─────────────────────────────────────────
      case 'getContractorBadges': {
        const { contractor_id } = body;
        if (!contractor_id) return json({ error: 'Missing contractor_id' }, 400);

        const { data: c } = await sb(env,
          `/contractors?id=eq.${contractor_id}&select=rating,jobs_completed,verified,created_at,response_rate`
        );
        if (!c?.[0]) return json({ badges: [] });

        return json({ badges: computeBadges(c[0]) });
      }


      // ── CHECK SUBSCRIBER (Supabase-based) ────────────────────────────────
      case 'checkSubscriber': {
        const { email, app } = body;
        if (!email) return json({ active: false });
        const { data } = await sb(env,
          `/subscriptions?email=eq.${encodeURIComponent(email.toLowerCase())}&status=eq.active&select=id,plan,app_access,expires_at`
        );
        const sub = data?.[0];
        if (!sub) return json({ active: false });
        // Check expiry
        if (sub.expires_at && new Date(sub.expires_at) < new Date()) {
          return json({ active: false, expired: true });
        }
        // Check app access if specified
        if (app && sub.app_access && sub.app_access.length > 0) {
          if (!sub.app_access.includes(app)) return json({ active: false, app_not_included: true });
        }
        return json({ active: true, plan: sub.plan });
      }

      // ── ADD SUBSCRIBER ────────────────────────────────────────────────────
      case 'addSubscriber': {
        const { email, plan, square_sub_id, square_customer_id } = body;
        if (!email) return json({ success: false, error: 'Email required' });
        const expires_at = await activateSubscription(
          env, email.toLowerCase(), plan || 'monthly',
          square_sub_id || null, square_customer_id || null
        );
        return json({ success: true, expires_at });
      }

      // ── CANCEL SUBSCRIBER ─────────────────────────────────────────────────
      case 'cancelSubscriber': {
        const { email, square_sub_id } = body;
        const filter = square_sub_id
          ? `/subscriptions?square_sub_id=eq.${square_sub_id}`
          : `/subscriptions?email=eq.${encodeURIComponent((email||'').toLowerCase())}`;
        await sb(env, filter, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'cancelled',
            cancelled_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        });
        return json({ success: true });
      }

      // ── RECORD AGREEMENT / DIGITAL SIGNATURE ────────────────────────────
      case 'recordAgreement': {
        const {
          agreement_type, agreement_version, full_name, email,
          user_agent, contractor_id, project_id, agreement_text
        } = body;

        if (!agreement_type || !full_name || !email) {
          return json({ error: 'Missing required fields' }, 400);
        }

        // IP captured server-side — cannot be spoofed by client
        const ip_address = request.headers?.get('CF-Connecting-IP') ||
                           request.headers?.get('X-Forwarded-For') || 'unknown';

        const { data, status: dbStatus } = await sb(env, '/agreements', {
          method: 'POST',
          body: JSON.stringify({
            agreement_type,
            agreement_version: agreement_version || '2025-01-01',
            full_name,
            email,
            ip_address,
            user_agent:    user_agent || '',
            contractor_id: contractor_id || null,
            project_id:    project_id   || null,
            agreement_text: agreement_text || '',
            signed_at:     new Date().toISOString()
          })
        });

        if (dbStatus !== 201) {
          return json({ error: 'Failed to record agreement' }, 500);
        }

        const record = Array.isArray(data) ? data[0] : data;

        // Update contractor record with signature timestamp if applicable
        if (contractor_id) {
          await sb(env, `/contractors?id=eq.${contractor_id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              terms_accepted_at: new Date().toISOString(),
              terms_accepted_ip: ip_address
            })
          });
        }

        // Update project record if homeowner agreement
        if (project_id && agreement_type === 'homeowner') {
          await sb(env, `/projects?id=eq.${project_id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              terms_accepted_at: new Date().toISOString(),
              terms_accepted_ip: ip_address
            })
          });
        }

        return json({
          success:    true,
          agreement_id: record.id,
          signed_at:  record.signed_at,
          ip_address
        });
      }

      // squareWebhook — handled at top of fetch() via square-signature header detection

      default:
        return json({ error: 'Unhandled action' }, 400);
    }

  } catch (err) {
    return json({ error: 'Internal error: ' + err.message }, 500);
  }
}

// ── PROJECT MATCHING ENGINE ───────────────────────────────────────────────────
// Finds the best available contractor and sends them the match offer.
// Returns: 'matched' | 'exhausted' | 'no_contractors' | 'error'
async function matchProject(project, env, excludeContractorId = null) {
  try {
    // Get all previous match attempts for this project
    const { data: existingMatches } = await sb(env,
      `/matches?project_id=eq.${project.id}&select=contractor_id`
    );
    const alreadyOffered = (existingMatches || []).map(m => m.contractor_id);
    if (excludeContractorId) alreadyOffered.push(excludeContractorId);

    // Find verified subscribed contractors in same state + category
    let query = `/contractors?verified=eq.true&active_subscription=eq.true&state=eq.${encodeURIComponent(project.state)}`;
    if (project.category) {
      query += `&categories=like.*${encodeURIComponent(project.category)}*`;
    }
    query += '&order=rating.desc,jobs_completed.desc';

    const { data: candidates } = await sb(env, query);

    // ── NO CONTRACTORS IN AREA AT ALL ────────────────────────────────────
    if (!candidates?.length) {
      await handleNoContractors(project, env, 'no_contractors');
      return 'no_contractors';
    }

    // Filter out already-offered contractors
    const available = candidates.filter(c => !alreadyOffered.includes(c.id));

    // ── ALL CONTRACTORS EXHAUSTED ─────────────────────────────────────────
    if (!available.length) {
      await handleNoContractors(project, env, 'exhausted');
      return 'exhausted';
    }

    const contractor = available[0];
    const expiresAt  = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    // Create match record
    await sb(env, '/matches', {
      method: 'POST',
      body: JSON.stringify({
        project_id:    project.id,
        contractor_id: contractor.id,
        status:        'offered',
        expires_at:    expiresAt
      })
    });

    // Email contractor
    await sendEmail(env,
      contractor.email,
      'New job opportunity — respond within 2 hours',
      `<p>Hi ${contractor.name},</p>
       <p>A new project matching your services is available:</p>
       <p><strong>${project.title}</strong></p>
       <p>${project.description}</p>
       <p><strong>Location:</strong> ${project.zip_code}, ${project.state}</p>
       <p><strong>Budget:</strong> ${project.budget_range || 'Not specified'}</p>
       <p><strong>Timeline:</strong> ${project.timeline || 'Flexible'}</p>
       ${project.estimate ? `<p style="background:#f0f7ff;border-left:3px solid #4f8eff;padding:.5rem .8rem;border-radius:0 6px 6px 0;margin:.5rem 0"><strong>Estimated Market Rate:</strong> $${parseInt(project.estimate.low).toLocaleString()} – $${parseInt(project.estimate.high).toLocaleString()} <span style="font-size:.85em;color:#666">(${project.estimate.notes || ''})</span></p>` : ''}
       <p>You have <strong>24 hours</strong> to accept or decline.</p>
       <p><a href="https://contactinfinitysolutionsllc-ops.github.io/contractor-dashboard/">View and respond in your dashboard →</a></p>
       <br><p>— InfinityMatch</p>`
    );

    return 'matched';
  } catch (err) {
    console.error('matchProject error:', err);
    return 'error';
  }
}

// ── NO MATCH HANDLER ──────────────────────────────────────────────────────────
// Called when no contractor is available — notifies homeowner honestly and admin
async function handleNoContractors(project, env, reason) {
  // Only send "no match" emails once — check if already notified
  if (project.status === 'no_match_notified') return;

  // Mark project so we don't send duplicate no-match emails
  await sb(env, `/projects?id=eq.${project.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: reason === 'exhausted' ? 'no_match_notified' : 'no_contractors' })
  });

  const isExhausted = reason === 'exhausted';

  // Email homeowner — honest, no false promises
  await sendEmail(env,
    project.homeowner_email,
    'Update on your InfinityMatch project',
    `<p>Hi ${project.homeowner_name},</p>
     <p>Thank you for submitting your project: <strong>${project.title}</strong>.</p>
     ${isExhausted
       ? `<p>We reached out to all available contractors in your area but weren't able to find a match right now. This sometimes happens in areas with limited contractor coverage.</p>`
       : `<p>We don't currently have a verified contractor in your area for <strong>${project.category}</strong> work.</p>`
     }
     <p><strong>Here's what happens next:</strong></p>
     <p>We're actively working to expand contractor coverage in your area. You'll receive an email notification as soon as a contractor becomes available for your project — no need to resubmit.</p>
     <p>If you need help sooner, you can reach us directly at <a href="mailto:contact.infinitysolutionsllc@gmail.com">contact.infinitysolutionsllc@gmail.com</a> and we'll do our best to help personally.</p>
     <p>We appreciate your patience and we're sorry we couldn't match you immediately.</p>
     <br><p>— InfinityMatch Team</p>`
  );

  // Email admin — so you can manually try to find a contractor
  await sendEmail(env,
    'contact.infinitysolutionsllc@gmail.com',
    `⚠️ Unmatched project — needs manual attention`,
    `<p><strong>Project could not be automatically matched.</strong></p>
     <p><strong>Reason:</strong> ${isExhausted ? 'All contractors in area declined or expired' : 'No contractors registered for this trade/area'}</p>
     <p><strong>Title:</strong> ${project.title}</p>
     <p><strong>Category:</strong> ${project.category}</p>
     <p><strong>Location:</strong> ${project.zip_code}, ${project.state}</p>
     <p><strong>Homeowner:</strong> ${project.homeowner_name} · ${project.homeowner_email} · ${project.homeowner_phone || 'no phone'}</p>
     <p><strong>Description:</strong> ${project.description}</p>
     <p><strong>Budget:</strong> ${project.budget_range || 'Not specified'} · <strong>Timeline:</strong> ${project.timeline || 'Flexible'}</p>
     <p><strong>Project ID:</strong> ${project.id}</p>
     <p>Log into the admin panel to manually assign a contractor or reach out directly to the homeowner.</p>`
  );
}

// ── CRON TRIGGER — runs every 15 minutes ────────────────────────────────────
export const scheduled = async (event, env, ctx) => {
  try {
    const now = new Date().toISOString();

    // ── 1. EXPIRE STALE MATCHES AND REROUTE ──────────────────────────────
    const { data: expired } = await sb(env,
      `/matches?status=eq.offered&expires_at=lt.${now}&select=*,projects(*)`
    );
    for (const match of (expired || [])) {
      await sb(env, `/matches?id=eq.${match.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'expired' })
      });
      const project = match.projects;
      if (project && project.status === 'pending') {
        await matchProject(project, env, match.contractor_id);
      }
    }

    // ── 2. STUCK PENDING PROJECTS — no match attempt yet ─────────────────
    // Projects pending for 2+ hours with no match attempts = no contractors exist
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: stuckPending } = await sb(env,
      `/projects?status=eq.pending&created_at=lt.${twoHoursAgo}`
    );
    for (const project of (stuckPending || [])) {
      // Check if any match was ever attempted
      const { data: attempts } = await sb(env,
        `/matches?project_id=eq.${project.id}&select=id`
      );
      if (!attempts?.length) {
        // Never matched — no contractors available at all
        await handleNoContractors(project, env, 'no_contractors');
      }
    }

    // ── 3. CONTRACTOR GHOST CHECK — accepted but no follow-through ───────
    // Projects matched 48+ hours ago with no completion — send follow-up to homeowner
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: stuckMatched } = await sb(env,
      `/projects?status=eq.matched&assigned_at=lt.${twoDaysAgo}&ghost_check_sent=is.null`
    );
    for (const project of (stuckMatched || [])) {
      await sendEmail(env,
        project.homeowner_email,
        'Quick check-in on your InfinityMatch project',
        `<p>Hi ${project.homeowner_name},</p>
         <p>We matched your project <strong>${project.title}</strong> with a contractor 2 days ago.</p>
         <p>Has the contractor reached out to you yet?</p>
         <p>If you haven't heard from them, please let us know at <a href="mailto:contact.infinitysolutionsllc@gmail.com">contact.infinitysolutionsllc@gmail.com</a> and we'll follow up immediately.</p>
         <br><p>— InfinityMatch Team</p>`
      );
      // Mark as checked so we don't email again
      await sb(env, `/projects?id=eq.${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ghost_check_sent: new Date().toISOString() })
      });
      // Alert admin too
      await sendEmail(env,
        'contact.infinitysolutionsllc@gmail.com',
        `⚠️ Ghost check — contractor may not have contacted homeowner`,
        `<p>Project matched 48+ hours ago with no confirmed contact:</p>
         <p><strong>${project.title}</strong> — ${project.homeowner_name} (${project.homeowner_email})</p>
         <p>Assigned contractor ID: ${project.assigned_contractor_id}</p>`
      );
    }

    // ── 4. EXPIRING INSURANCE / LICENSES ─────────────────────────────────
    // Warn contractors 30 days before expiry
    const thirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const today = now;
    const { data: expiring } = await sb(env,
      `/verifications?expires_at=lt.${thirtyDays}&expires_at=gt.${today}&expiry_warned=is.null`
    );
    for (const verif of (expiring || [])) {
      const { data: contractors } = await sb(env,
        `/contractors?id=eq.${verif.contractor_id}`
      );
      const contractor = contractors?.[0];
      if (contractor) {
        await sendEmail(env,
          contractor.email,
          `Action required — your ${verif.type} expires soon`,
          `<p>Hi ${contractor.name},</p>
           <p>Your <strong>${verif.type}</strong> on file with InfinityMatch expires on <strong>${new Date(verif.expires_at).toLocaleDateString()}</strong>.</p>
           <p>Please upload an updated document before it expires to avoid interruption to your matches.</p>
           <p><a href="https://contactinfinitysolutionsllc-ops.github.io/contractor-dashboard/">Update in your dashboard →</a></p>
           <br><p>— InfinityMatch Team</p>`
        );
        await sb(env, `/verifications?id=eq.${verif.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ expiry_warned: new Date().toISOString() })
        });
      }
    }

    // ── 5. SUSPEND CONTRACTORS WITH EXPIRED DOCS ──────────────────────────
    const { data: expiredDocs } = await sb(env,
      `/verifications?expires_at=lt.${today}&status=eq.approved`
    );
    for (const verif of (expiredDocs || [])) {
      await sb(env, `/contractors?id=eq.${verif.contractor_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ verified: false })
      });
      await sb(env, `/verifications?id=eq.${verif.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', notes: 'Auto-expired' })
      });
    }

  } catch (err) {
    console.error('Cron error:', err);
  }
};

// ── JSON HELPER ───────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}