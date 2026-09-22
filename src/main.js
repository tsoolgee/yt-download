// ---------- חיווט: כפתור צף, בחירת וידאו/אודיו, הורדה ----------

const infoCache = new Map(); // id -> info (קישורים פגים; 403 מנקה אותו)
let busy = null;             // { abort, percent }
let btn = null;

const guard = e => { e.preventDefault(); e.returnValue = ''; };
function setGuard() {
  removeEventListener('beforeunload', guard);
  if (busy) addEventListener('beforeunload', guard);
}

function paint() {
  if (!btn) return;
  const p = busy?.percent;
  const kids = [icon(busy ? (p ?? 0) : null)];
  if (busy && p != null) kids.push(h('span', { class: 'ytdl-pct' }, Math.floor(p) + '%'));
  btn.replaceChildren(...kids);
  btn.title = busy ? 'לחיצה לביטול ההורדה' : 'הורדת הסרטון';
}

async function getInfo(id, signal) {
  if (!infoCache.has(id)) infoCache.set(id, await fetchStreams(id, signal));
  return infoCache.get(id);
}

function onClick() {
  if (busy) { busy.abort.abort(); return; }
  const id = videoId();
  if (!id) return;

  openMenu(btn, async (render, place) => {
    try {
      const info = await getInfo(id, new AbortController().signal);
      const best = info.videos[0];
      render(
        h('div', { class: 'ytdl-head' }, info.length ? 'אורך ' + hhmmss(info.length) : 'מה להוריד?'),
        best && item('וידאו · ' + (best.qualityLabel || best.height + 'p'),
          mb(+best.contentLength + +info.audio.contentLength),
          () => { closeMenu(); start(id, info, 'video'); }),
        item('אודיו · M4A', mb(+info.audio.contentLength) + ' · מיידי',
          () => { closeMenu(); start(id, info, 'm4a'); }),
        item('אודיו · MP3', 'קידוד מחדש, איטי יותר',
          () => { closeMenu(); start(id, info, 'mp3'); }),
      );
      place();
    } catch (e) {
      if (e.name === 'AbortError') return;
      render(h('div', { class: 'ytdl-err' }, e.message || 'לא הצלחתי לקרוא את פרטי הסרטון'));
      place();
    }
  });
}

// מוריד פורמט אחד (או אודיו לבד), ממזג ושומר.
// mp3=true מפעיל קידוד מחדש; אחרת האודיו נשמר כמו שיוטיוב שלח אותו.
async function run(info, format, mp3, abort) {
  const files = format ? [format, info.audio] : [info.audio];
  const total = files.reduce((n, f) => n + (+f.contentLength || 0), 0);
  let done = 0, shown = 0;
  const tick = n => {
    done += n;
    if (!total || !busy) return;
    busy.percent = Math.min(99, done / total * 100);
    if (Date.now() - shown > 150) { shown = Date.now(); paint(); }
  };

  const buffers = [];
  for (const f of files) buffers.push(await fetchFile(f, tick, abort.signal));
  if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');

  busy.percent = 100;
  paint();
  await sleep(30); // שהדפדפן יצייר 100% לפני המיזוג, שחוסם את הת'רד

  const parts = Mux.build(buffers, info.length);
  const base = safeName(info.title);
  if (format) {
    saveFile(parts, base + '.mp4', 'video/mp4');
    return base + '.mp4';
  }

  // M4A: ה-AAC של יוטיוב כמו שהוא – רק מיזוג, בלי אובדן איכות ובלי המתנה
  if (!mp3) {
    saveFile(parts, base + '.m4a', 'audio/mp4');
    return base + '.m4a';
  }

  // MP3: יוטיוב לא מגיש MP3 בכלל, אז מפענחים ומקודדים מחדש
  toast('ממיר ל-MP3…', 'הורדה הסתיימה, נשאר רק לקודד');
  busy.percent = 0;
  paint();
  let last = 0;
  const encoded = await toMp3(parts, info, p => {
    if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
    busy.percent = p * 100;
    if (Date.now() - last > 150) { last = Date.now(); paint(); }
  });
  saveFile(encoded, base + '.mp3', 'audio/mpeg');
  return base + '.mp3';
}

const outOfMemory = e => e && (e.name === 'RangeError' || e.tooLarge);

async function start(id, info, kind) {
  const abort = new AbortController();
  busy = { abort, percent: null };
  setGuard();
  paint();

  // וידאו: מהאיכות הגבוהה ומטה. אם הזיכרון לא מספיק – יורדים שלב במקום להיכשל.
  const ladder = kind === 'video' ? info.videos : [null];
  try {
    for (let i = 0; i < ladder.length; i++) {
      busy.percent = null;
      paint();
      try {
        const name = await run(info, ladder[i], kind === 'mp3', abort);
        toast('הקובץ נשמר', name);
        return;
      } catch (e) {
        if (!outOfMemory(e) || i + 1 >= ladder.length) throw e;
        const next = ladder[i + 1];
        toast('הסרטון כבד לדפדפן', 'מנסה ב-' + (next.qualityLabel || next.height + 'p'), 4000);
      }
    }
  } catch (e) {
    if (e.name === 'AbortError' || abort.signal.aborted) toast('ההורדה בוטלה', null, 3000);
    else {
      if (e.expired) infoCache.delete(id); // קישור פג – בפעם הבאה נבקש טרי
      toast('ההורדה נכשלה', outOfMemory(e) ? 'אין מספיק זיכרון בדפדפן לסרטון הזה' : e.message);
    }
  } finally {
    busy = null;
    setGuard();
    paint();
  }
}

// ---------- הרכבה ----------

function mount() {
  if (!videoId()) { btn?.remove(); btn = null; closeMenu(); return; }
  if (btn?.isConnected) return;
  injectCss();
  btn = h('button', { class: 'ytdl-fab', onclick: onClick });
  paint();
  document.body.append(btn);
}

function boot() {
  mount();
  // יוטיוב הוא SPA: גם ניווט וגם בנייה מחדש של ה-body
  new MutationObserver(() => mount()).observe(document.documentElement, { childList: true, subtree: true });
  // תפריט פתוח לא נשאר תלוי כשנכנסים למסך מלא או יוצאים ממנו
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, closeMenu);
  for (const ev of ['yt-navigate-finish', 'yt-page-data-updated', 'state-navigatefinish']) {
    addEventListener(ev, () => { closeMenu(); setTimeout(mount, 0); }, true);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
