// בודק שהורדה מתאוששת מחיתוכים אקראיים באמצע הזרם – התקלה שנטפרי גרמה.
// node test/fetch.test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');

const ctx = {
  console, Uint8Array, Promise, Math, Error, Date, JSON, Map, Set, String, Number,
  DOMException, AbortController, ReadableStream, Response, TextEncoder,
  setTimeout, clearTimeout,
  sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 3))),
  window: {}, document: { title: '' }, location: { origin: 'https://www.youtube.com' },
  h: () => ({}), URL: global.URL, Blob: global.Blob,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../src/yt.js', 'utf8') + ';this.fetchFile = fetchFile;', ctx);

const TOTAL = 25 * 1024 * 1024;
const data = new Uint8Array(TOTAL);
for (let i = 0, s = 12345; i < TOTAL; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; data[i] = s & 255; }

// fetch מדומה: מגיש את הטווח בפיסות, ולפעמים נחתך באמצע כמו מסנן תוכן
function makeFetch({ cutRate = 0, status = 200, alwaysFail = false }) {
  const stats = { requests: 0, cuts: 0 };
  ctx.fetch = async (url, opts) => {
    stats.requests++;
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (alwaysFail) throw new TypeError('Failed to fetch');
    if (status !== 200) return { ok: false, status };
    const [, a, b] = url.match(/&range=(\d+)-(\d+)/);
    const from = +a, to = +b;
    const cutAt = Math.random() < cutRate ? from + Math.floor(Math.random() * (to - from)) : null;
    if (cutAt !== null) stats.cuts++;
    let pos = from;
    return {
      ok: true, status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (pos > to) return { done: true };
            if (cutAt !== null && pos >= cutAt) throw new TypeError('Failed to fetch');
            const n = Math.min(64 * 1024, to - pos + 1);
            const value = data.subarray(pos, pos + n);
            pos += n;
            return { done: false, value };
          },
        }),
      },
    };
  };
  return stats;
}

(async () => {
  const fmt = { url: 'https://x.googlevideo.com/videoplayback?id=1', contentLength: String(TOTAL) };

  // 1. ללא תקלות – התוצאה זהה בייט-בייט
  makeFetch({});
  let got = await ctx.fetchFile(fmt, () => {}, new AbortController().signal);
  assert.strictEqual(got.length, TOTAL);
  assert(Buffer.from(got).equals(Buffer.from(data)), 'הורדה נקייה זהה למקור');

  // 2. חיתוכים אקראיים ב-40% מהבקשות – חייב להתאושש ולהחזיר בדיוק אותו דבר
  for (const rate of [0.4, 0.7]) {
    const stats = makeFetch({ cutRate: rate });
    let bytes = 0;
    got = await ctx.fetchFile(fmt, n => { bytes += n; }, new AbortController().signal);
    assert.strictEqual(got.length, TOTAL);
    assert(Buffer.from(got).equals(Buffer.from(data)), `שיעור חיתוך ${rate}: הקובץ זהה למקור`);
    assert(stats.cuts > 0, 'הבדיקה באמת חתכה');
    assert(bytes >= TOTAL, 'התקדמות נספרה');
    console.log(`  חיתוך ${rate * 100}%: ${stats.cuts} חיתוכים ב-${stats.requests} בקשות – הושלם במלואו`);
  }

  // 3. 403 (קישור פג) נכשל מיד, בלי ניסיונות חוזרים
  const s403 = makeFetch({ status: 403 });
  await assert.rejects(() => ctx.fetchFile(fmt, () => {}, new AbortController().signal), e => e.expired);
  assert(s403.requests <= 4, `403 לא חוזר על עצמו (${s403.requests} בקשות)`);
  console.log(`  קישור פג (403): נכשל מיד אחרי ${s403.requests} בקשות`);

  // 4. כשלון רצוף בלי התקדמות – מוותר, לא נתקע
  const sDead = makeFetch({ alwaysFail: true });
  await assert.rejects(() => ctx.fetchFile(fmt, () => {}, new AbortController().signal));
  console.log(`  רשת מתה: ויתר אחרי ${sDead.requests} בקשות`);

  // 5. ביטול באמצע – מתוך callback ההתקדמות, כדי שהתזמון יהיה ודאי
  const ac = new AbortController();
  makeFetch({});
  let ticks = 0;
  await assert.rejects(
    () => ctx.fetchFile(fmt, () => { if (++ticks === 3) ac.abort(); }, ac.signal),
    e => e.name === 'AbortError');
  console.log(`  ביטול: נעצר אחרי ${ticks} פיסות`);

  console.log('כל בדיקות ההורדה עברו');
})().catch(e => { console.error('נכשל:', e.message); process.exit(1); });
