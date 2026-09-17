// ---------- הליבה: קישורים ישירים מיוטיוב, הורדה בחלקים, שמירה ----------

// לקוח ה-visionOS מחזיר קישורים ישירים בלי חתימה מוצפנת (signatureCipher),
// בלי חניקת פרמטר n ובלי PO token – ולכן אפשר להוריד בלי להריץ את ה-JS של הנגן.
// כשההורדה מפסיקה לעבוד: לבדוק מה yt-dlp משתמש בו היום (INNERTUBE_CLIENTS).
const CLIENT = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
  headerId: '101',
};

// חלקים קטנים: על חיבור מסונן (נטפרי) בקשות וידאו ארוכות נחתכות באמצע,
// ואז יש פחות מה לחזור עליו. ראה RETRIES – החיתוכים האלה מקריים.
const CHUNK = 4 * 1024 * 1024;  // גודל חלק בהורדה המקבילה
const LANES = 4;                // כמה חלקים מורידים במקביל
const RETRIES = 8;              // ניסיונות רצופים *בלי* התקדמות לפני ויתור

// מבקש מיוטיוב את רשימת הזרמים של הסרטון.
async function fetchStreams(id, signal) {
  const headers = {
    'content-type': 'application/json',
    'X-YouTube-Client-Name': CLIENT.headerId,
    'X-YouTube-Client-Version': CLIENT.clientVersion,
  };
  try {
    const visitor = window.ytcfg?.get?.('VISITOR_DATA');
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
  } catch {}

  const { headerId, ...client } = CLIENT;
  const r = await fetch(location.origin + '/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    credentials: 'omit', // בלי קוקיז: אחרת יוטיוב מחייב PO token
    headers,
    signal,
    body: JSON.stringify({
      context: { client: { ...client, hl: 'he' } },
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!r.ok) throw new Error(r.status === 418 ? 'יוטיוב חסם את הבקשה' : 'יוטיוב החזיר שגיאה ' + r.status);

  const data = await r.json();
  const status = data.playabilityStatus || {};
  if (status.status !== 'OK') {
    const err = new Error(status.reason || 'אי אפשר להוריד את הסרטון הזה (' + (status.status || 'לא ידוע') + ')');
    if (status.reason) err.ytReason = true;
    throw err;
  }

  // רק MP4: זה מה שהמוקסר יודע למזג, וזה מה שנפתח בכל נגן.
  // isDrc = פס קול עם דחיסת דינמיקה, לא הגרסה המקורית.
  const formats = (data.streamingData?.adaptiveFormats || [])
    .filter(f => f.url && !f.isDrc && !/[?&]xtags=[^&]*drc/.test(f.url));

  const audio = formats
    .filter(f => f.mimeType.startsWith('audio/mp4'))
    .sort((a, b) => b.bitrate - a.bitrate)[0];
  if (!audio) throw new Error('יוטיוב לא החזיר קישורים שאפשר להוריד לסרטון הזה');

  // לכל איכות בוחרים פורמט אחד: H.264 עדיף (נפתח בכל מקום), ואחריו הקצב הגבוה
  const byLabel = new Map();
  for (const f of formats.filter(f => f.mimeType.startsWith('video/mp4'))) {
    const label = (f.qualityLabel || f.height + 'p').replace(/ .*/, '');
    const avc = /avc1/.test(f.mimeType);
    const cur = byLabel.get(label);
    if (!cur || (avc && !cur.avc) || (avc === cur.avc && f.bitrate > cur.f.bitrate)) byLabel.set(label, { f, avc });
  }
  const videos = [...byLabel.values()]
    .map(x => x.f)
    .sort((a, b) => b.height - a.height || (b.fps || 0) - (a.fps || 0));

  return {
    id,
    title: data.videoDetails?.title || document.title.replace(/ - YouTube.*$/, ''),
    author: data.videoDetails?.author || '',
    length: +data.videoDetails?.lengthSeconds || 0,
    audio,
    videos,
  };
}

// מוריד פורמט אחד לזיכרון. בקשות Range מקבילות – פי כמה מהר מבקשה אחת ארוכה.
async function fetchFile(format, onBytes, signal) {
  const total = +format.contentLength;
  if (!total) {
    const r = await fetch(format.url, { signal, credentials: 'omit' });
    if (!r.ok) throw new Error('ההורדה נכשלה (' + r.status + ')');
    const buf = new Uint8Array(await r.arrayBuffer());
    onBytes(buf.length);
    return buf;
  }

  let out;
  try { out = new Uint8Array(total); } catch {
    const err = new Error('הקובץ גדול מדי להורדה מהדפדפן');
    err.tooLarge = true;
    throw err;
  }

  const ranges = [];
  for (let a = 0; a < total; a += CHUNK) ranges.push([a, Math.min(a + CHUNK, total) - 1]);

  // תקלה סופית בחלק אחד עוצרת גם את השאר – בלי עוד בקשות שייכשלו (403 על קישור שפג)
  const stop = new AbortController();
  let fatal = null;
  const onAbort = () => stop.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  const worker = async () => {
    for (let range; !stop.signal.aborted && (range = ranges.shift());) {
      let [pos, end] = range, tries = 0;
      while (pos <= end) {
        const before = pos;
        try {
          const r = await fetch(`${format.url}&range=${pos}-${end}`, {
            signal: stop.signal, credentials: 'omit', cache: 'no-store',
          });
          if (!r.ok) {
            const err = new Error('ההורדה נכשלה (' + r.status + ')');
            // 4xx לא מסתדר בניסיון חוזר (403 = הקישור פג); 429 כן
            err.fatal = r.status >= 400 && r.status < 500 && r.status !== 429;
            err.expired = r.status === 403;
            throw err;
          }
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const n = Math.min(value.length, end - pos + 1);
            out.set(value.subarray(0, n), pos);
            pos += n;
            onBytes(n);
          }
          if (pos <= end) throw new Error('החיבור נקטע');
        } catch (e) {
          if (stop.signal.aborted) throw e;
          // כל עוד הבקשה הביאה בייטים חדשים – החיתוך לא "תקלה", רק המשך מכאן
          tries = pos > before ? 0 : tries + 1;
          if (e.fatal || tries > RETRIES) { fatal = fatal || e; stop.abort(); throw e; }
          await sleep(300 * tries);
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(LANES, ranges.length) }, worker));
  } catch (e) {
    throw fatal || e;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  return out;
}

// שמירה לדיסק. Blob מחלקים – כרום כותב אותו לדיסק ולא מחזיק הכול ב-RAM.
function saveFile(parts, name, type) {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.documentElement.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}
