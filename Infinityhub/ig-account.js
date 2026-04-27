/*!
 * ig-account.js — Infinity Solutions Unified Account Button
 * Copyright 2025 Infinity Solutions LLC. All Rights Reserved.
 *
 * Drop one script tag into any app before </body>:
 * <script src="https://contactinfinitysolutionsllc-ops.github.io/account/ig-account.js"></script>
 *
 * What it does:
 * - Adds an Account button to .nav-right on any page
 * - If logged in via Supabase: shows avatar + name, account link, sign out
 * - If not logged in: shows a popup with email + password sign in / create account
 * - Bridges the shared Supabase session to the current app's loginSuccess() if it exists
 * - Stores ig_account_email in localStorage for subscription checks
 * - Requires email + password — never just email
 */
(function () {
  'use strict';

  const SB_URL      = 'https://zcvkgevcrgsujnqovxgd.supabase.co';
  const SB_KEY      = 'sb_publishable_WeAsyK0Xo7G-VbhIwFUlNQ_pGNmu75T';
  const SB_SESS_KEY = 'sb-zcvkgevcrgsujnqovxgd-auth-token';
  const ACCOUNT_URL = 'https://contactinfinitysolutionsllc-ops.github.io/account/';
  const WORKER_URL  = 'https://justdocs-worker.robertjosephreynolds.workers.dev';

  // ── SHARED SESSION ──────────────────────────────────────────────────────
  function getSharedSession() {
    try {
      const raw = localStorage.getItem(SB_SESS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const sess   = parsed?.currentSession || parsed?.session || parsed;
      const user   = sess?.user;
      const token  = sess?.access_token;
      const exp    = sess?.expires_at;
      if (user?.email && token && (!exp || Date.now() / 1000 < exp)) {
        return { id: user.id, email: user.email, token,
                 name: user.user_metadata?.name || user.email.split('@')[0] };
      }
    } catch (e) {}
    return null;
  }

  // ── RAW SUPABASE AUTH (no SDK needed) ───────────────────────────────────
  async function sbSignIn(email, password) {
    const r = await fetch(SB_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    return r.json();
  }

  async function sbSignUp(email, password) {
    const r = await fetch(SB_URL + '/auth/v1/signup', {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password,
        options: { emailRedirectTo: ACCOUNT_URL } })
    });
    return r.json();
  }

  async function sbSignOut(token) {
    await fetch(SB_URL + '/auth/v1/logout', {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + token }
    }).catch(() => {});
  }

  // ── INJECT STYLES ───────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('ig-account-styles')) return;
    const s = document.createElement('style');
    s.id = 'ig-account-styles';
    s.textContent = `
      #ig-acct-btn{display:inline-flex;align-items:center;gap:.35rem;cursor:pointer;
        font-family:'Syne',system-ui,sans-serif;font-weight:700;font-size:.78rem;
        color:var(--muted2,#a0a8c0);background:rgba(79,142,255,.08);
        border:1px solid rgba(79,142,255,.2);border-radius:100px;
        padding:.28rem .75rem .28rem .28rem;transition:all .18s;position:relative;z-index:300;}
      #ig-acct-btn:hover{color:var(--text,#f0f2f8);border-color:rgba(79,142,255,.4);}
      #ig-acct-avatar{width:20px;height:20px;border-radius:50%;
        background:rgba(79,142,255,.2);display:inline-flex;align-items:center;
        justify-content:center;font-size:.65rem;color:#7eb0ff;font-weight:800;flex-shrink:0;}

      #ig-acct-overlay{display:none;position:fixed;inset:0;z-index:998;background:rgba(0,0,0,.5);
        backdrop-filter:blur(4px);}
      #ig-acct-overlay.open{display:block;}

      #ig-acct-popup{position:fixed;z-index:999;top:60px;right:1.2rem;width:320px;
        background:var(--bg2,#0e1320);border:1px solid rgba(255,255,255,.12);
        border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);
        font-family:'Instrument Sans',system-ui,sans-serif;overflow:hidden;
        display:none;}
      #ig-acct-popup.open{display:block;animation:ig-up .2s ease both;}
      @keyframes ig-up{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}

      .ig-popup-head{padding:1rem 1.1rem .8rem;border-bottom:1px solid rgba(255,255,255,.07);}
      .ig-popup-logo{font-family:'Syne',sans-serif;font-weight:800;font-size:.85rem;
        color:var(--text,#f0f2f8);margin-bottom:.15rem;}
      .ig-popup-logo em{color:#4f8eff;font-style:normal;}
      .ig-popup-sub{font-size:.72rem;color:var(--muted,#7a8099);}

      .ig-tabs{display:flex;background:rgba(255,255,255,.04);border-radius:8px;
        padding:2px;gap:2px;margin-bottom:1rem;}
      .ig-tab{flex:1;padding:.45rem;text-align:center;border-radius:7px;cursor:pointer;
        font-family:'Syne',sans-serif;font-weight:700;font-size:.78rem;
        color:var(--muted2,#a0a8c0);border:none;background:transparent;transition:all .15s;}
      .ig-tab.active{background:rgba(79,142,255,.15);color:#7eb0ff;}

      .ig-popup-body{padding:.8rem 1.1rem 1rem;}
      .ig-fg{margin-bottom:.7rem;}
      .ig-lbl{display:block;font-size:.65rem;font-weight:600;letter-spacing:.07em;
        text-transform:uppercase;color:var(--muted2,#a0a8c0);margin-bottom:.3rem;}
      .ig-inp{width:100%;padding:.6rem .8rem;background:rgba(255,255,255,.05);
        border:1px solid rgba(255,255,255,.1);border-radius:8px;
        font-family:'Instrument Sans',system-ui,sans-serif;font-size:.88rem;
        color:var(--text,#f0f2f8);outline:none;transition:border-color .18s;box-sizing:border-box;}
      .ig-inp:focus{border-color:#4f8eff;}
      .ig-inp::placeholder{color:var(--muted,#7a8099);}
      .ig-btn{width:100%;font-family:'Syne',sans-serif;font-weight:700;font-size:.88rem;
        padding:.72rem;border-radius:100px;border:none;cursor:pointer;
        background:#4f8eff;color:#fff;transition:all .18s;margin-top:.2rem;}
      .ig-btn:hover{background:#7eb0ff;transform:translateY(-1px);}
      .ig-btn:disabled{opacity:.4;cursor:not-allowed;transform:none;}
      .ig-msg{border-radius:7px;padding:.55rem .8rem;font-size:.78rem;
        margin-bottom:.6rem;line-height:1.4;display:none;}
      .ig-msg.error{background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.25);color:#ff6b6b;}
      .ig-msg.success{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.25);color:#34d399;}
      .ig-msg.info{background:rgba(79,142,255,.1);border:1px solid rgba(79,142,255,.25);color:#7eb0ff;}

      .ig-acct-info{padding:.8rem 1.1rem;}
      .ig-acct-row{display:flex;align-items:center;gap:.7rem;margin-bottom:.8rem;}
      .ig-acct-big-av{width:36px;height:36px;border-radius:50%;background:rgba(79,142,255,.18);
        display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;
        font-weight:800;font-size:.9rem;color:#7eb0ff;flex-shrink:0;}
      .ig-acct-email{font-size:.82rem;font-weight:500;color:var(--text,#f0f2f8);}
      .ig-acct-since{font-size:.68rem;color:var(--muted,#7a8099);margin-top:1px;}
      .ig-acct-links{display:flex;flex-direction:column;gap:4px;}
      .ig-acct-link{display:block;padding:.55rem .8rem;border-radius:8px;
        font-size:.82rem;font-weight:500;color:var(--muted2,#a0a8c0);text-decoration:none;
        transition:all .15s;cursor:pointer;border:none;background:transparent;
        text-align:left;width:100%;}
      .ig-acct-link:hover{background:rgba(255,255,255,.05);color:var(--text,#f0f2f8);}
      .ig-acct-link.danger:hover{color:#ff6b6b;}
      .ig-divider{height:1px;background:rgba(255,255,255,.07);margin:.4rem 0;}
    `;
    document.head.appendChild(s);
  }

  // ── BUILD POPUP HTML ────────────────────────────────────────────────────
  function buildPopup() {
    const overlay = document.createElement('div');
    overlay.id = 'ig-acct-overlay';
    overlay.addEventListener('click', closePopup);

    const popup = document.createElement('div');
    popup.id = 'ig-acct-popup';
    popup.innerHTML = `
      <div class="ig-popup-head">
        <div class="ig-popup-logo">Infinity<em>.</em>Solutions</div>
        <div class="ig-popup-sub">Your account for every tool</div>
      </div>

      <!-- AUTH PANEL -->
      <div id="ig-auth-panel" class="ig-popup-body">
        <div class="ig-tabs">
          <button class="ig-tab active" id="ig-tab-in"  onclick="igSwitchTab('in')">Sign In</button>
          <button class="ig-tab"        id="ig-tab-up"  onclick="igSwitchTab('up')">Create Account</button>
        </div>
        <div id="ig-msg" class="ig-msg"></div>

        <!-- SIGN IN -->
        <div id="ig-form-in">
          <div class="ig-fg"><label class="ig-lbl">Email</label>
            <input type="email" class="ig-inp" id="ig-email-in" placeholder="you@email.com" autocomplete="email"></div>
          <div class="ig-fg"><label class="ig-lbl">Password</label>
            <input type="password" class="ig-inp" id="ig-pass-in" placeholder="Your password" autocomplete="current-password"
              onkeydown="if(event.key==='Enter')igDoSignIn()"></div>
          <button class="ig-btn" id="ig-btn-in" onclick="igDoSignIn()">Sign In →</button>
          <div style="text-align:center;margin-top:.6rem">
            <button onclick="igForgot()" style="background:none;border:none;color:var(--muted,#7a8099);
              font-size:.73rem;cursor:pointer;text-decoration:underline">Forgot password?</button>
          </div>
        </div>

        <!-- CREATE ACCOUNT -->
        <div id="ig-form-up" style="display:none">
          <div class="ig-fg"><label class="ig-lbl">Email</label>
            <input type="email" class="ig-inp" id="ig-email-up" placeholder="you@email.com" autocomplete="email"></div>
          <div class="ig-fg"><label class="ig-lbl">Password <span style="font-weight:400;text-transform:none;letter-spacing:0">(min 8 chars)</span></label>
            <input type="password" class="ig-inp" id="ig-pass-up" placeholder="At least 8 characters" autocomplete="new-password"
              onkeydown="if(event.key==='Enter')igDoSignUp()"></div>
          <div class="ig-fg"><label class="ig-lbl">Confirm Password</label>
            <input type="password" class="ig-inp" id="ig-pass-up2" placeholder="Repeat your password" autocomplete="new-password"
              onkeydown="if(event.key==='Enter')igDoSignUp()"></div>
          <button class="ig-btn" id="ig-btn-up" onclick="igDoSignUp()">Create Account →</button>
        </div>
      </div>

      <!-- LOGGED IN PANEL -->
      <div id="ig-loggedin-panel" class="ig-acct-info" style="display:none">
        <div class="ig-acct-row">
          <div class="ig-acct-big-av" id="ig-big-av">?</div>
          <div>
            <div class="ig-acct-email" id="ig-acct-email-disp"></div>
            <div class="ig-acct-since" id="ig-sub-status">Checking subscription…</div>
          </div>
        </div>
        <div class="ig-acct-links">
          <a class="ig-acct-link" href="${ACCOUNT_URL}">👤 My Account &amp; Subscriptions</a>
          <a class="ig-acct-link" href="${ACCOUNT_URL}" onclick="igGoChangePassword(event)">🔑 Change Password</a>
          <div class="ig-divider"></div>
          <button class="ig-acct-link danger" onclick="igDoSignOut()">Sign Out</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(popup);
  }

  // ── POPUP OPEN/CLOSE ────────────────────────────────────────────────────
  function openPopup() {
    document.getElementById('ig-acct-overlay').classList.add('open');
    document.getElementById('ig-acct-popup').classList.add('open');
  }
  function closePopup() {
    document.getElementById('ig-acct-overlay').classList.remove('open');
    document.getElementById('ig-acct-popup').classList.remove('open');
  }

  // ── ACCOUNT BUTTON ──────────────────────────────────────────────────────
  function buildButton(session) {
    const btn = document.createElement('div');
    btn.id = 'ig-acct-btn';
    btn.addEventListener('click', function(e) { e.stopPropagation(); openPopup(); });

    if (session) {
      btn.innerHTML = `
        <span id="ig-acct-avatar" class="ig-acct-avatar">${session.email[0].toUpperCase()}</span>
        Account`;
    } else {
      btn.innerHTML = `
        <span id="ig-acct-avatar" class="ig-acct-avatar">→</span>
        Sign In`;
    }

    // Try to inject into nav-right, fall back to fixed position
    const navRight = document.querySelector('.nav-right') ||
                     document.querySelector('.app-hdr-right') ||
                     document.querySelector('.land-nav-btns');
    if (navRight) {
      navRight.insertBefore(btn, navRight.firstChild);
    } else {
      btn.style.cssText += 'position:fixed;top:14px;right:1rem;z-index:400;';
      document.body.appendChild(btn);
    }
  }

  // ── SHOW LOGGED-IN STATE ────────────────────────────────────────────────
  function showLoggedIn(session, appId) {
    const authPanel     = document.getElementById('ig-auth-panel');
    const loggedInPanel = document.getElementById('ig-loggedin-panel');
    if (authPanel)     authPanel.style.display     = 'none';
    if (loggedInPanel) loggedInPanel.style.display = 'block';

    const av    = document.getElementById('ig-big-av');
    const email = document.getElementById('ig-acct-email-disp');
    const sub   = document.getElementById('ig-sub-status');
    if (av)    av.textContent    = session.email[0].toUpperCase();
    if (email) email.textContent = session.email;

    // Update the button
    const btn = document.getElementById('ig-acct-btn');
    const av2 = document.getElementById('ig-acct-avatar');
    if (btn) btn.innerHTML = `<span id="ig-acct-avatar" class="ig-acct-avatar">${session.email[0].toUpperCase()}</span> Account`;

    // Check subscription for this app
    if (appId && sub) {
      fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'checkSubscriber', email: session.email, app: appId })
      })
      .then(r => r.json())
      .then(d => {
        if (sub) sub.textContent = d.active ? '✓ Subscription active' : 'No active subscription';
        if (sub) sub.style.color = d.active ? '#34d399' : '#7a8099';
      })
      .catch(() => { if (sub) sub.textContent = ''; });
    } else if (sub) {
      sub.textContent = '';
    }
  }

  // ── AUTH ACTIONS (global so onclick works) ──────────────────────────────
  window.igSwitchTab = function(tab) {
    document.getElementById('ig-form-in').style.display  = tab === 'in' ? 'block' : 'none';
    document.getElementById('ig-form-up').style.display  = tab === 'up' ? 'block' : 'none';
    document.getElementById('ig-tab-in').classList.toggle('active', tab === 'in');
    document.getElementById('ig-tab-up').classList.toggle('active', tab === 'up');
    igClearMsg();
  };

  window.igClearMsg = function() {
    const el = document.getElementById('ig-msg');
    if (el) { el.style.display = 'none'; el.textContent = ''; }
  };

  window.igMsg = function(text, type) {
    const el = document.getElementById('ig-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'ig-msg ' + (type || 'error');
    el.style.display = 'block';
  };

  window.igSetBusy = function(btnId, busy, label) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = busy;
    if (busy)  btn.dataset.orig = btn.textContent;
    btn.textContent = busy ? 'Please wait…' : (btn.dataset.orig || label || btn.textContent);
  };

  window.igDoSignIn = async function() {
    const email = (document.getElementById('ig-email-in')?.value || '').trim().toLowerCase();
    const pass  =  document.getElementById('ig-pass-in')?.value  || '';
    if (!email || !pass) { igMsg('Please enter your email and password.'); return; }
    if (!email.includes('@')) { igMsg('Enter a valid email address.'); return; }
    igSetBusy('ig-btn-in', true);
    igClearMsg();
    try {
      const data = await sbSignIn(email, pass);
      igSetBusy('ig-btn-in', false, 'Sign In →');
      if (data.error) {
        const m = data.error.message || '';
        if (m.includes('not confirmed')) igMsg('Check your email — click the confirmation link first.', 'info');
        else if (m.includes('Invalid login')) igMsg('Incorrect email or password.');
        else igMsg(m || 'Sign in failed.');
        return;
      }
      // Save to localStorage for other apps
      localStorage.setItem('ig_account_email', email);
      igHandleNewSession(data);
    } catch(e) {
      igSetBusy('ig-btn-in', false, 'Sign In →');
      igMsg('Network error — please try again.');
    }
  };

  window.igDoSignUp = async function() {
    const email = (document.getElementById('ig-email-up')?.value  || '').trim().toLowerCase();
    const pass  =  document.getElementById('ig-pass-up')?.value   || '';
    const pass2 =  document.getElementById('ig-pass-up2')?.value  || '';
    if (!email || !pass) { igMsg('Please fill in all fields.'); return; }
    if (!email.includes('@')) { igMsg('Enter a valid email address.'); return; }
    if (pass.length < 8)  { igMsg('Password must be at least 8 characters.'); return; }
    if (pass !== pass2)   { igMsg('Passwords do not match.'); return; }
    igSetBusy('ig-btn-up', true);
    igClearMsg();
    try {
      const data = await sbSignUp(email, pass);
      igSetBusy('ig-btn-up', false, 'Create Account →');
      if (data.error) { igMsg(data.error.message || 'Signup failed.'); return; }
      if (data.access_token) {
        localStorage.setItem('ig_account_email', email);
        igHandleNewSession(data);
      } else {
        igMsg('Account created! Check your email to confirm, then sign in.', 'success');
      }
    } catch(e) {
      igSetBusy('ig-btn-up', false, 'Create Account →');
      igMsg('Network error — please try again.');
    }
  };

  window.igForgot = async function() {
    const email = (document.getElementById('ig-email-in')?.value || '').trim().toLowerCase();
    if (!email) { igMsg('Enter your email above first.', 'info'); return; }
    await fetch(SB_URL + '/auth/v1/recover', {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, options: { redirectTo: ACCOUNT_URL } })
    }).catch(() => {});
    igMsg('If that account exists, a reset link has been sent.', 'info');
  };

  window.igDoSignOut = async function() {
    const sess = getSharedSession();
    if (sess?.token) await sbSignOut(sess.token);
    localStorage.removeItem(SB_SESS_KEY);
    localStorage.removeItem('ig_account_email');
    // Clear current app's own session if it has one
    for (const key of Object.keys(localStorage)) {
      if (key.match(/^(learn|wellness|biz|resume|contract|grant|credit|mail|social|reputation|listing|legacy)_user$/)) {
        localStorage.removeItem(key);
      }
    }
    closePopup();
    // Reload so app shows landing/auth screen
    window.location.reload();
  };

  window.igGoChangePassword = function(e) {
    e.preventDefault();
    window.open(ACCOUNT_URL, '_blank');
    closePopup();
  };

  // ── HANDLE NEW SESSION ──────────────────────────────────────────────────
  function igHandleNewSession(data) {
    const user  = data.user;
    const token = data.access_token;
    if (!user || !token) { igMsg('Unexpected response. Please try again.'); return; }

    // Store session in the format Supabase SDK expects
    // so it's readable by all apps
    const sessObj = {
      currentSession: {
        access_token: token,
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        user
      }
    };
    localStorage.setItem(SB_SESS_KEY, JSON.stringify(sessObj));
    localStorage.setItem('ig_account_email', user.email);

    const session = { id: user.id, email: user.email, token,
                      name: user.user_metadata?.name || user.email.split('@')[0] };

    // Bridge to current app's own auth if it has loginSuccess
    if (typeof window.loginSuccess === 'function') {
      window.loginSuccess(user, token, session.name);
    }

    // Update popup to logged-in state
    const appId = window.APP_NAME || window.APP_ID || null;
    showLoggedIn(session, appId);
    closePopup();
  }

  // ── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    buildPopup();

    const session = getSharedSession();
    buildButton(session);

    if (session) {
      // Already logged in - bridge to current app and show logged-in state
      const appId = window.APP_NAME || window.APP_ID || null;
      if (typeof window.loginSuccess === 'function' && !window.currentUser) {
        window.loginSuccess(session, session.token, session.name);
      }
      showLoggedIn(session, appId);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
