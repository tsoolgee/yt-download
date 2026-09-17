// מיזוג קובצי DASH של יוטיוב (MP4 מפוצל) לקובץ MP4 רגיל – בלי ffmpeg.
//
// הקלט: לכל מסלול קובץ שלם עם moov אחד ורצף moof+mdat. הפלט אינו מפוצל:
// moov אחד עם טבלאות דגימות אמיתיות (stts/stsc/stsz/stco) ו-mdat אחד.
// זה מה שנגנים ותיקים ותוכנות עריכה מצפים לו; מבנה מפוצל חלקם לא פותחים.
// הפריימים עצמם מועתקים כמות שהם – אין קידוד מחדש.
const Mux = (() => {
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const w32 = (b, o, v) => {
    b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
  };
  const w64 = (b, o, v) => { w32(b, o, Math.floor(v / 4294967296)); w32(b, o + 4, v >>> 0); };
  const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));
  const fail = () => { throw new Error('מבנה הקובץ שיוטיוב שלח לא נתמך'); };

  function list(b, start, end) {
    const out = [];
    for (let o = start; o + 8 <= end;) {
      let size = u32(b, o), hdr = 8;
      if (size === 1) { size = u64(b, o + 8); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) fail();
      out.push({
        type: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]),
        start: o, body: o + hdr, end: o + size,
      });
      o += size;
    }
    return out;
  }
  const kids = (b, p) => list(b, p.body, p.end);
  const find = (b, p, type) => (p && kids(b, p).find(x => x.type === type)) || fail();
  const maybe = (b, p, type) => (p ? kids(b, p).find(x => x.type === type) : null);

  function box(type, parts) {
    const len = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    w32(out, 0, len);
    out.set(ascii(type), 4);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  // מעתיק קופסת-אב ומחליף בתוכה ילד אחד (trak/mdia/minf/stbl – כולן מכולות פשוטות)
  function swap(b, parent, type, child) {
    const parts = kids(b, parent).map(k => (k.type === type ? child : b.subarray(k.start, k.end)));
    return box(parent.type, parts);
  }

  // ---------- קריאת המקטעים ----------

  function parse(b) {
    const top = list(b, 0, b.length);
    const moov = top.find(x => x.type === 'moov') || fail();
    const trak = find(b, moov, 'trak');
    const mdia = find(b, trak, 'mdia');
    const mdhd = find(b, mdia, 'mdhd');
    const timescale = u32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
    const trex = find(b, find(b, moov, 'mvex'), 'trex');
    const def = {
      dur: u32(b, trex.body + 12),
      size: u32(b, trex.body + 16),
      flags: u32(b, trex.body + 20),
    };

    const chunks = [];
    for (const moof of top) {
      if (moof.type !== 'moof') continue;
      const traf = find(b, moof, 'traf');
      const tfhd = find(b, traf, 'tfhd');
      const tf = u32(b, tfhd.body) & 0xffffff;

      let p = tfhd.body + 8; // אחרי version/flags ו-track_ID
      let base = moof.start; // ברירת המחדל, וגם המשמעות של default-base-is-moof
      if (tf & 0x1) { base = u64(b, p); p += 8; }
      if (tf & 0x2) p += 4;
      const dDur = (tf & 0x8) ? u32(b, (p += 4) - 4) : def.dur;
      const dSize = (tf & 0x10) ? u32(b, (p += 4) - 4) : def.size;
      const dFlags = (tf & 0x20) ? u32(b, (p += 4) - 4) : def.flags;

      const tfdt = maybe(b, traf, 'tfdt');
      const time = !tfdt ? 0 : (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4));

      const samples = [];
      for (const trun of kids(b, traf)) {
        if (trun.type !== 'trun') continue;
        const ver = b[trun.body];
        const fl = u32(b, trun.body) & 0xffffff;
        const count = u32(b, trun.body + 4);
        let q = trun.body + 8;
        let off = base;
        if (fl & 0x1) { off = base + i32(b, q); q += 4; }
        const first = (fl & 0x4) ? u32(b, (q += 4) - 4) : null;
        for (let i = 0; i < count; i++) {
          const dur = (fl & 0x100) ? u32(b, (q += 4) - 4) : dDur;
          const size = (fl & 0x200) ? u32(b, (q += 4) - 4) : dSize;
          const sf = (fl & 0x400) ? u32(b, (q += 4) - 4) : (i === 0 && first !== null ? first : dFlags);
          const cto = (fl & 0x800) ? (ver === 0 ? u32(b, (q += 4) - 4) : i32(b, (q += 4) - 4)) : 0;
          samples.push({ off, size, dur, cto, sync: !(sf & 0x10000) });
          off += size;
        }
      }
      if (samples.length) chunks.push({ time: time / timescale, samples });
    }
    if (!chunks.length) fail();
    return { b, moov, trak, mdia, mdhd, timescale, chunks };
  }

  // ---------- טבלאות ה-stbl ----------

  const full = (type, extra, fill) => {
    const body = new Uint8Array(8 + extra);
    fill(body);
    return box(type, [body]);
  };

  // מאחד דגימות עוקבות בעלות אותו ערך לשורה אחת
  function runs(samples, get) {
    const out = [];
    for (const s of samples) {
      const last = out[out.length - 1];
      if (last && last[1] === get(s)) last[0]++; else out.push([1, get(s)]);
    }
    return out;
  }

  function stts(samples) {
    const rows = runs(samples, s => s.dur);
    return full('stts', rows.length * 8, body => {
      w32(body, 4, rows.length);
      rows.forEach(([c, d], i) => { w32(body, 8 + i * 8, c); w32(body, 12 + i * 8, d); });
    });
  }

  function ctts(samples) {
    if (!samples.some(s => s.cto !== 0)) return null;
    const signed = samples.some(s => s.cto < 0);
    const rows = runs(samples, s => s.cto);
    return full('ctts', rows.length * 8, body => {
      body[0] = signed ? 1 : 0;
      w32(body, 4, rows.length);
      rows.forEach(([c, v], i) => { w32(body, 8 + i * 8, c); w32(body, 12 + i * 8, v >>> 0); });
    });
  }

  function stss(samples) {
    const idx = [];
    samples.forEach((s, i) => { if (s.sync) idx.push(i + 1); });
    if (idx.length === samples.length) return null; // הכול נקודות סנכרון – הקופסה מיותרת
    return full('stss', idx.length * 4, body => {
      w32(body, 4, idx.length);
      idx.forEach((n, i) => w32(body, 8 + i * 4, n));
    });
  }

  function stsc(perChunk) {
    const rows = [];
    perChunk.forEach((n, i) => {
      const last = rows[rows.length - 1];
      if (!last || last[1] !== n) rows.push([i + 1, n, 1]);
    });
    return full('stsc', rows.length * 12, body => {
      w32(body, 4, rows.length);
      rows.forEach(([c, n, d], i) => {
        w32(body, 8 + i * 12, c); w32(body, 12 + i * 12, n); w32(body, 16 + i * 12, d);
      });
    });
  }

  function stsz(samples) {
    const same = samples.every(s => s.size === samples[0].size);
    return full('stsz', 4 + (same ? 0 : samples.length * 4), body => {
      w32(body, 4, same ? samples[0].size : 0);
      w32(body, 8, samples.length);
      if (!same) samples.forEach((s, i) => w32(body, 12 + i * 4, s.size));
    });
  }

  function chunkOffsets(offsets, base, wide) {
    const w = wide ? 8 : 4;
    return full(wide ? 'co64' : 'stco', offsets.length * w, body => {
      w32(body, 4, offsets.length);
      offsets.forEach((o, i) => (wide ? w64 : w32)(body, 8 + i * w, o + base));
    });
  }

  // ---------- הרכבה ----------

  // inputs: מערך Uint8Array (וידאו ואז אודיו, או רק אודיו). מחזיר חלקים ל-Blob.
  function build(inputs, durationSec) {
    const tracks = inputs.map(parse);

    // סדר הכתיבה: משזרים את המקטעים לפי זמן, כדי שנגינה לא תקפוץ בקובץ
    const order = [];
    tracks.forEach((t, i) => t.chunks.forEach(c => order.push({ t: i, time: c.time, samples: c.samples })));
    order.sort((a, b) => a.time - b.time || a.t - b.t);

    // פריסת ה-mdat: היסטים יחסיים לתחילתו; גודל הכותרת נוסף בהמשך
    const lay = tracks.map(() => ({ offsets: [], perChunk: [], samples: [] }));
    const slices = [];
    let pos = 0;
    for (const c of order) {
      const L = lay[c.t];
      L.offsets.push(pos);
      L.perChunk.push(c.samples.length);
      // דגימות רצופות במקור מתאחדות לפרוסה אחת – פחות חלקים ל-Blob
      let run = null;
      for (const s of c.samples) {
        L.samples.push(s);
        pos += s.size;
        if (run && s.off === run.end) run.end += s.size;
        else { run = { b: tracks[c.t].b, start: s.off, end: s.off + s.size }; slices.push(run); }
      }
    }
    const mdatBytes = pos;
    const wide = mdatBytes + 16 > 0xffffffff;

    const ftyp = box('ftyp', [ascii('isom'), new Uint8Array([0, 0, 2, 0]), ascii('isomiso2avc1mp41')]);
    const mvhdBox = find(tracks[0].b, tracks[0].moov, 'mvhd');
    const mvhdSrc = tracks[0].b.slice(mvhdBox.start, mvhdBox.end);
    const mv1 = mvhdSrc[8] === 1;
    const movScale = u32(mvhdSrc, mv1 ? 28 : 20);

    const makeMoov = base => {
      const mvhd = mvhdSrc.slice();
      let longest = 0;

      const traks = tracks.map((t, i) => {
        const L = lay[i];
        const ticks = L.samples.reduce((n, s) => n + s.dur, 0);
        const secs = ticks / t.timescale;
        if (secs > longest) longest = secs;

        const minf = find(t.b, t.mdia, 'minf');
        const stsd = find(t.b, find(t.b, minf, 'stbl'), 'stsd');
        const newStbl = box('stbl', [
          t.b.subarray(stsd.start, stsd.end),
          stts(L.samples), ctts(L.samples), stss(L.samples),
          stsc(L.perChunk), stsz(L.samples), chunkOffsets(L.offsets, base, wide),
        ].filter(Boolean));

        // mdhd: משך המדיה בפועל, לפי סכום הדגימות
        const mdhd = t.b.slice(t.mdhd.start, t.mdhd.end);
        if (mdhd[8] === 1) w64(mdhd, 32, ticks); else w32(mdhd, 24, ticks);

        const newMdia = box('mdia', kids(t.b, t.mdia).map(k => (
          k.type === 'mdhd' ? mdhd
            : k.type === 'minf' ? swap(t.b, minf, 'stbl', newStbl)
              : t.b.subarray(k.start, k.end))));

        // tkhd: מזהה מסלול ייחודי ומשך בסולם הסרט
        return box('trak', kids(t.b, t.trak).map(k => {
          if (k.type === 'mdia') return newMdia;
          if (k.type !== 'tkhd') return t.b.subarray(k.start, k.end);
          const tkhd = t.b.slice(k.start, k.end);
          const tv1 = tkhd[8] === 1;
          w32(tkhd, 8 + (tv1 ? 20 : 12), i + 1);
          const d = Math.round(secs * movScale);
          if (tv1) w64(tkhd, 8 + 28, d); else w32(tkhd, 8 + 20, d);
          return tkhd;
        }));
      });

      const total = Math.round((durationSec > 0 ? Math.max(durationSec, longest) : longest) * movScale);
      if (mv1) w64(mvhd, 32, total); else w32(mvhd, 24, total);
      w32(mvhd, mv1 ? 116 : 104, tracks.length + 1); // next_track_ID
      return box('moov', [mvhd, ...traks]);
    };

    // שני מעברים: הראשון רק כדי לדעת את גודל ה-moov, השני עם ההיסטים הנכונים.
    // רוחב ההיסטים קבוע, ולכן הגודל זהה בשני המעברים.
    const probe = makeMoov(0);
    const mdatHdr = wide ? 16 : 8;
    const moov = makeMoov(ftyp.length + probe.length + mdatHdr);

    const head = new Uint8Array(mdatHdr);
    if (wide) { w32(head, 0, 1); head.set(ascii('mdat'), 4); w64(head, 8, mdatBytes + 16); }
    else { w32(head, 0, mdatBytes + 8); head.set(ascii('mdat'), 4); }

    return [ftyp, moov, head, ...slices.map(s => s.b.subarray(s.start, s.end))];
  }

  return { build };
})();
