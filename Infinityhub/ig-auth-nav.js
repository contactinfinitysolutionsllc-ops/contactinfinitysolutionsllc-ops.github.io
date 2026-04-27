// ig-auth-nav.js — Infinity Solutions shared auth nav snippet
// Drop this script tag into any app page, right before </body>
// Requires a .nav-right element in the page nav.
//
// Usage:
// <script src="https://contactinfinitysolutionsllc-ops.github.io/account/ig-auth-nav.js"></script>
//
// What it does:
// - Checks if user is logged in via shared localStorage tokens (set by account page)
// - If logged in: adds "👤 Account" link to .nav-right pointing to account page
// - If not: adds "Sign In" link pointing to account page with ?return= param

(function() {
  const ACCOUNT_URL = 'https://contactinfinitysolutionsllc-ops.github.io/account/';

  function getStoredSession() {
    const token = localStorage.getItem('ig_account_token');
    const email = localStorage.getItem('ig_account_email');
    if (!token || !email) return null;
    try {
      const p = JSON.parse(atob(token.split('.')[1]));
      if (p.exp && Date.now() / 1000 > p.exp) {
        ['ig_account_token','ig_account_email','ig_account_name'].forEach(k => localStorage.removeItem(k));
        return null;
      }
    } catch(e) { return null; }
    return { token, email, name: localStorage.getItem('ig_account_name') || email };
  }

  function addNavItem(html) {
    const navRight = document.querySelector('.nav-right');
    if (!navRight) return;
    const div = document.createElement('div');
    div.innerHTML = html;
    const badge = navRight.querySelector('.nav-badge');
    if (badge) navRight.insertBefore(div.firstChild, badge);
    else navRight.appendChild(div.firstChild);
  }

  window.addEventListener('DOMContentLoaded', function() {
    const session = getStoredSession();

    if (session) {
      addNavItem(`
        <a href="${ACCOUNT_URL}" style="
          display:inline-flex;align-items:center;gap:.4rem;
          font-size:.78rem;color:var(--muted2,#a0a8c0);text-decoration:none;
          background:rgba(79,142,255,.08);border:1px solid rgba(79,142,255,.18);
          border-radius:100px;padding:.22rem .7rem .22rem .3rem;transition:all .18s;
        " onmouseover="this.style.color='var(--text,#f0f2f8)'" onmouseout="this.style.color='var(--muted2,#a0a8c0)'">
          <span style="
            width:20px;height:20px;border-radius:50%;
            background:rgba(79,142,255,.2);
            display:inline-flex;align-items:center;justify-content:center;
            font-family:'Syne',sans-serif;font-weight:800;font-size:.65rem;
            color:#7eb0ff;flex-shrink:0;
          ">${session.email[0].toUpperCase()}</span>
          Account
        </a>
      `);
    } else {
      addNavItem(`
        <a href="${ACCOUNT_URL}?return=${encodeURIComponent(window.location.href)}" style="
          font-size:.78rem;color:var(--muted2,#a0a8c0);text-decoration:none;transition:color .18s;
        " onmouseover="this.style.color='var(--text,#f0f2f8)'" onmouseout="this.style.color='var(--muted2,#a0a8c0)'">
          Sign in
        </a>
      `);
    }
  });
})();
