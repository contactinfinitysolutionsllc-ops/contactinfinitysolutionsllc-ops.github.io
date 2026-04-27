// ig-shared-auth.js — Infinity Solutions shared auth bridge
// Add to any page that has a loginSuccess(user, token, name) function.
// It auto-logs in users already signed in via the account page.

(function() {
  const ACCOUNT_URL = 'https://contactinfinitysolutionsllc-ops.github.io/account/';

  function getSharedSession() {
    // Primary: tokens explicitly set by account page (most reliable)
    try {
      const token = localStorage.getItem('ig_account_token');
      const email = localStorage.getItem('ig_account_email');
      const name  = localStorage.getItem('ig_account_name');
      if (token && email) {
        const p = JSON.parse(atob(token.split('.')[1]));
        if (!p.exp || Date.now() / 1000 < p.exp) {
          return { id: p.sub, email, name: name || email.split('@')[0], token };
        }
        // Expired — clean up
        ['ig_account_token','ig_account_email','ig_account_name'].forEach(k => localStorage.removeItem(k));
      }
    } catch(e) {}

    // Fallback: raw Supabase session key (older sessions before account page fix)
    try {
      const raw = localStorage.getItem('sb-zcvkgevcrgsujnqovxgd-auth-token');
      if (raw) {
        const parsed = JSON.parse(raw);
        const sess   = parsed?.currentSession || parsed?.session || parsed;
        const user   = sess?.user;
        const token  = sess?.access_token;
        const exp    = sess?.expires_at;
        if (user?.email && token && (!exp || Date.now() / 1000 < exp)) {
          return {
            id:    user.id,
            email: user.email,
            name:  user.user_metadata?.name || user.email.split('@')[0],
            token
          };
        }
      }
    } catch(e) {}

    return null;
  }

  function updateNavForLoggedInUser(email) {
    const btns = document.querySelector('.land-nav-btns');
    if (!btns) return;
    btns.innerHTML =
      '<a href="' + ACCOUNT_URL + '" ' +
      'style="display:inline-flex;align-items:center;gap:.4rem;font-family:Syne,sans-serif;' +
      'font-weight:700;font-size:.82rem;color:var(--text);text-decoration:none;' +
      'background:rgba(240,180,41,.1);border:1px solid rgba(240,180,41,.22);' +
      'padding:.45rem 1.1rem;border-radius:100px">' +
      '<span style="width:22px;height:22px;border-radius:50%;background:rgba(240,180,41,.2);' +
      'display:inline-flex;align-items:center;justify-content:center;font-size:.7rem;color:var(--accent);">' +
      email[0].toUpperCase() + '</span> My Account</a>' +
      '<button class="btn-n btn-n-solid" onclick="showScreen(\'app\')">Open App →</button>';
  }

  window.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() {
      // If page already has an active session, just update the nav
      if (typeof currentUser !== 'undefined' && currentUser && currentUser.email) {
        updateNavForLoggedInUser(currentUser.email);
        return;
      }

      var shared = getSharedSession();
      if (!shared) return;

      // Store shared email for subscription checks
      localStorage.setItem('ig_account_email', shared.email);
      if (shared.token) localStorage.setItem('ig_account_token', shared.token);
      if (shared.name)  localStorage.setItem('ig_account_name',  shared.name);

      // Auto-login if the page has a loginSuccess callback
      if (typeof loginSuccess === 'function') {
        loginSuccess({ id: shared.id, email: shared.email }, shared.token, shared.name);
        updateNavForLoggedInUser(shared.email);
      }
    }, 100);
  });
})();
