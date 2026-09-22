// ---------- ממשק: כפתור צף בצד המסך, תפריט וידאו/אודיו, התקדמות ----------

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, props) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(props || {})) el.setAttribute(k, v);
  return el;
};

const CSS = `
.ytdl-fab {
  position: fixed; left: 16px; top: 50%; transform: translateY(-50%);
  z-index: 2500; width: 52px; height: 52px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%; cursor: pointer;
  background: #0f0f0f; color: #fff;
  box-shadow: 0 2px 10px rgba(0,0,0,.35);
  font: 500 12px/1 "Roboto", "Noto Sans Hebrew", Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  transition: transform .12s ease, background .12s ease;
}
html[dark] .ytdl-fab, [dark] .ytdl-fab { background: #f1f1f1; color: #0f0f0f; }
.ytdl-fab:hover { transform: translateY(-50%) scale(1.06); }
.ytdl-fab svg { width: 26px; height: 26px; fill: currentColor; }
.ytdl-fab .ytdl-ring { fill: none; stroke: currentColor; stroke-width: 2.2; }
.ytdl-fab .ytdl-ring-bg { opacity: .25; }
.ytdl-fab .ytdl-pct {
  position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center; font-size: 11px;
}

.ytdl-menu {
  position: fixed; z-index: 2600; min-width: 230px; padding: 8px 0;
  border-radius: 12px; direction: rtl;
  background: var(--yt-spec-menu-background, #fff);
  color: var(--yt-spec-text-primary, #0f0f0f);
  box-shadow: 0 4px 32px rgba(0,0,0,.25);
  font: 400 14px/1.3 "Roboto", "Noto Sans Hebrew", Arial, sans-serif;
}
.ytdl-item {
  display: flex; align-items: center; justify-content: space-between; gap: 20px;
  width: 100%; padding: 11px 16px; cursor: pointer; border: none;
  background: none; color: inherit; font: inherit; text-align: start;
}
.ytdl-item:hover { background: var(--yt-spec-10-percent-layer, rgba(0,0,0,.1)); }
.ytdl-size { opacity: .6; font-size: 12px; font-variant-numeric: tabular-nums; }
.ytdl-head { padding: 6px 16px 10px; font-size: 12px; opacity: .6; }
.ytdl-credit {
  display: block; padding: 2px 16px 9px; font-size: 11px; letter-spacing: .03em;
  color: inherit; text-decoration: none; opacity: .5;
}
.ytdl-credit:hover { opacity: .95; text-decoration: underline; }
.ytdl-sep { height: 1px; margin: 0 0 6px; background: var(--yt-spec-10-percent-layer, rgba(0,0,0,.1)); }
.ytdl-err { padding: 10px 16px; max-width: 300px; color: #c00; }

.ytdl-toast {
  position: fixed; left: 16px; bottom: 24px; z-index: 2700;
  max-width: 380px; padding: 13px 18px; border-radius: 10px; direction: rtl;
  background: #0f0f0f; color: #fff; box-shadow: 0 4px 32px rgba(0,0,0,.3);
  font: 400 14px/1.4 "Roboto", "Noto Sans Hebrew", Arial, sans-serif;
}
.ytdl-toast b { display: block; font-weight: 500; margin-bottom: 2px; }
.ytdl-toast span { opacity: .7; font-size: 13px; }

/* מסך מלא: יוטיוב מבקש fullscreen על <html> עצמו, אז כל מה שב-body נשאר גלוי.
   כל סלקטור בכלל נפרד – סלקטור לא מוכר מבטל את כל הרשימה שלו. */
html:fullscreen :is(.ytdl-fab, .ytdl-menu, .ytdl-toast) { display: none !important; }
html:-webkit-full-screen :is(.ytdl-fab, .ytdl-menu, .ytdl-toast) { display: none !important; }
html:has(:fullscreen) :is(.ytdl-fab, .ytdl-menu, .ytdl-toast) { display: none !important; }
html:has(ytd-watch-flexy[fullscreen], .html5-video-player.ytp-fullscreen) :is(.ytdl-fab, .ytdl-menu, .ytdl-toast) { display: none !important; }
`;

function injectCss() {
  if (document.getElementById('ytdl-css')) return;
  const style = h('style', { id: 'ytdl-css' });
  style.textContent = CSS;
  (document.head || document.documentElement).append(style);
}

// חץ הורדה, או טבעת התקדמות כשמורידים
function icon(percent) {
  const el = svg('svg', { viewBox: '0 0 24 24' });
  if (percent == null) {
    el.append(svg('path', { d: 'M12 3v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6V3h2zM4 19h16v2H4v-2z' }));
    return el;
  }
  const r = 10, c = 2 * Math.PI * r;
  el.append(svg('circle', { class: 'ytdl-ring ytdl-ring-bg', cx: 12, cy: 12, r }));
  el.append(svg('circle', {
    class: 'ytdl-ring', cx: 12, cy: 12, r,
    'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - percent / 100),
    'stroke-linecap': 'round', transform: 'rotate(-90 12 12)',
  }));
  return el;
}

let menuEl = null;
const closeMenu = () => { menuEl?.remove(); menuEl = null; };

// תפריט צמוד לכפתור: מימין לו אם יש מקום, אחרת משמאל.
function openMenu(anchor, build) {
  closeMenu();
  const box = h('div', { class: 'ytdl-menu' });
  const body = h('div');
  box.append(
    h('a', {
      class: 'ytdl-credit', href: 'https://tsoolgee.uk',
      target: '_blank', rel: 'noopener noreferrer',
    }, 'צול גאה · TSOOLGEE.UK'),
    h('div', { class: 'ytdl-sep' }),
    body,
  );
  menuEl = box;
  const render = (...kids) => body.replaceChildren(...kids.filter(Boolean));
  render(h('div', { class: 'ytdl-head' }, 'רגע, בודק מה יש…'));
  document.body.append(box);

  const place = () => {
    const a = anchor.getBoundingClientRect(), b = box.getBoundingClientRect();
    const right = a.right + 8;
    box.style.left = (right + b.width < innerWidth - 8 ? right : Math.max(8, a.left - b.width - 8)) + 'px';
    box.style.top = Math.max(8, Math.min(a.top + a.height / 2 - b.height / 2, innerHeight - b.height - 8)) + 'px';
  };
  place();

  const away = e => { if (menuEl && !box.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const esc = e => { if (e.key === 'Escape') closeMenu(); };
  setTimeout(() => {
    document.addEventListener('click', away, true);
    document.addEventListener('keydown', esc, true);
  });
  addEventListener('resize', place);
  // ניקוי כשהתפריט יורד מה-DOM
  new MutationObserver((_, o) => {
    if (box.isConnected) return;
    document.removeEventListener('click', away, true);
    document.removeEventListener('keydown', esc, true);
    removeEventListener('resize', place);
    o.disconnect();
  }).observe(document.body, { childList: true });

  build(render, place);
  return box;
}

const item = (label, sub, onclick) => h('button', { class: 'ytdl-item', onclick },
  h('span', {}, label),
  sub && h('span', { class: 'ytdl-size' }, sub));

let toastEl = null, toastTimer = 0;
function toast(title, sub, ms = 6000) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  toastEl = h('div', { class: 'ytdl-toast' }, h('b', {}, title), sub && h('span', {}, sub));
  document.body.append(toastEl);
  toastTimer = setTimeout(() => { toastEl?.remove(); toastEl = null; }, ms);
}
