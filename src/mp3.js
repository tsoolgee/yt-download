// ---------- המרה ל-MP3 ----------
// יוטיוב לא מגיש MP3 בכלל. הדרך היחידה היא לפענח את ה-AAC ולקודד מחדש,
// ולכן – בניגוד למיזוג הווידאו – כאן כן יש אובדן איכות וכן לוקח זמן.
// הפענוח ב-WebAudio (מובנה בדפדפן), הקידוד ב-lamejs.

const MP3_KBPS = 192;

// ID3v2.3: כותרת + פריימים של טקסט ב-UTF-16LE (הקידוד היחיד בגרסה 2.3
// שמכסה עברית). הגודל בכותרת הוא synchsafe – 7 ביטים לבייט.
function id3(title, artist) {
  const utf16 = s => {
    const b = new Uint8Array(3 + s.length * 2);
    b[0] = 1; b[1] = 0xff; b[2] = 0xfe; // encoding=UTF-16 + BOM
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      b[3 + i * 2] = c & 255;
      b[4 + i * 2] = c >> 8;
    }
    return b;
  };
  const frame = (id, text) => {
    const body = utf16(text);
    const f = new Uint8Array(10 + body.length);
    for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
    const n = body.length; // בגרסה 2.3 גודל הפריים הוא big-endian רגיל
    f[4] = n >>> 24; f[5] = (n >>> 16) & 255; f[6] = (n >>> 8) & 255; f[7] = n & 255;
    f.set(body, 10);
    return f;
  };

  const frames = [];
  if (title) frames.push(frame('TIT2', title));
  if (artist) frames.push(frame('TPE1', artist));
  if (!frames.length) return new Uint8Array(0);

  const size = frames.reduce((n, f) => n + f.length, 0);
  const head = new Uint8Array(10 + size);
  head.set([0x49, 0x44, 0x33, 3, 0, 0]); // "ID3", v2.3.0, בלי דגלים
  head[6] = (size >>> 21) & 127; head[7] = (size >>> 14) & 127;
  head[8] = (size >>> 7) & 127;  head[9] = size & 127;
  let o = 10;
  for (const f of frames) { head.set(f, o); o += f.length; }
  return head;
}

const toI16 = f => {
  const a = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = f[i] < -1 ? -1 : f[i] > 1 ? 1 : f[i];
    a[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return a;
};

// parts: הקובץ המוזג (m4a). מחזיר חלקים ל-Blob של MP3.
async function toMp3(parts, meta, onProgress) {
  const buf = await new Blob(parts, { type: 'audio/mp4' }).arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || typeof lamejs === 'undefined') throw new Error('הדפדפן לא תומך בהמרה ל-MP3');

  const ctx = new Ctx();
  let audio;
  try {
    audio = await ctx.decodeAudioData(buf);
  } catch {
    throw new Error('לא הצלחתי לפענח את פס הקול');
  } finally {
    ctx.close();
  }

  const ch = Math.min(2, audio.numberOfChannels);
  const enc = new lamejs.Mp3Encoder(ch, audio.sampleRate, MP3_KBPS);
  const L = audio.getChannelData(0);
  const R = ch > 1 ? audio.getChannelData(1) : null;

  const out = [id3(meta.title, meta.author)];
  const BLOCK = 1152 * 40; // כפולה של גודל פריים MP3
  for (let i = 0; i < L.length; i += BLOCK) {
    const l = toI16(L.subarray(i, i + BLOCK));
    const b = R ? enc.encodeBuffer(l, toI16(R.subarray(i, i + BLOCK))) : enc.encodeBuffer(l);
    if (b.length) out.push(new Uint8Array(b));
    onProgress(i / L.length);
    await sleep(0); // מחזיר את השליטה לדפדפן – אחרת הדף קופא
  }
  const tail = enc.flush();
  if (tail.length) out.push(new Uint8Array(tail));
  return out;
}
