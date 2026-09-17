// עזרים קטנים. יוטיוב אוכף Trusted Types, ולכן DOM נבנה ב-createElement בלבד.

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// באיזה אתר אנחנו – לכל אחד רכיבים אחרים (ytd-* / ytm-* / ytmusic-*)
const SITE = location.hostname.startsWith('music.') ? 'music'
  : location.hostname.startsWith('m.') ? 'mobile' : 'www';

function videoId() {
  const u = new URL(location.href);
  const v = u.searchParams.get('v');
  if (/^[\w-]{11}$/.test(v || '')) return v;
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
  return m ? m[1] : null;
}

// שם קובץ חוקי בחלונות: בלי \ / : * ? " < > | ובלי תווי בקרה
const safeName = t => [...(t || '')]
  .map(c => (c < ' ' || '\/:*?"<>|'.includes(c) ? ' ' : c))
  .join('').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';

const mb = n => (n < 1048576
  ? Math.max(1, Math.round(n / 1024)) + ' KB'
  : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB');

function hhmmss(sec) {
  sec = Math.max(0, Math.round(sec));
  const p = n => String(n).padStart(2, '0');
  return (sec >= 3600 ? Math.floor(sec / 3600) + ':' : '') + p(Math.floor(sec / 60) % 60) + ':' + p(sec % 60);
}
