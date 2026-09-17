// מיזוג קובצי DASH של יוטיוב (MP4 מפוצל) לקובץ MP4 אחד – בלי ffmpeg.
// כל קלט הוא קובץ שלם עם moov אחד ורצף של moof+mdat. הפלט: moov משותף
// שבו כל track מקבל מזהה משלו, והמקטעים משתלבים לפי זמן.
const Mux = (() => {
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const w32 = (b, o, v) => {
    b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
  };
  const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));
  const fail = () => { throw new Error('מבנה הקובץ שיוטיוב שלח לא נתמך'); };

  function list(b, start, end) {
    const out = [];
    for (let o = start; o + 8 <= end;) {
      let size = u32(b, o), hdr = 8;
      if (size === 1) { size = u32(b, o + 8) * 4294967296 + u32(b, o + 12); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) fail();
      out.push({ type: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), start: o, body: o + hdr, end: o + size });
      o += size;
    }
    return out;
  }
  const find = (b, parent, type) => (parent && list(b, parent.body, parent.end).find(x => x.type === type)) || fail();

  function box(type, parts) {
    const len = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    w32(out, 0, len);
    out.set(ascii(type), 4);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function parse(b) {
    const top = list(b, 0, b.length);
    const moov = top.find(x => x.type === 'moov') || fail();
    const trak = find(b, moov, 'trak');
    const mdhd = find(b, find(b, trak, 'mdia'), 'mdhd');
    const timescale = u32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
    const frags = [];
    for (let i = 0; i + 1 < top.length; i++) {
      if (top[i].type !== 'moof' || top[i + 1].type !== 'mdat') continue;
      const moof = top[i], traf = find(b, moof, 'traf'), tfhd = find(b, traf, 'tfhd');
      if (u32(b, tfhd.body) & 1) fail(); // base_data_offset מוחלט – ישתבש אחרי הזזה
      const tfdt = list(b, traf.body, traf.end).find(x => x.type === 'tfdt');
      const t = !tfdt ? 0 : b[tfdt.body] === 1
        ? u32(b, tfdt.body + 4) * 4294967296 + u32(b, tfdt.body + 8)
        : u32(b, tfdt.body + 4);
      frags.push({
        time: t / timescale,
        start: moof.start,
        end: top[i + 1].end,
        tfhd: tfhd.body + 4,
        mfhd: find(b, moof, 'mfhd').body + 4,
      });
    }
    if (!frags.length) fail();
    return { b, moov, trak, frags };
  }

  // inputs: מערך Uint8Array (וידאו ואז אודיו, או רק אודיו). מחזיר חלקים ל-Blob.
  function build(inputs, durationSec) {
    const tracks = inputs.map(parse);
    const first = tracks[0];
    const mvhd = first.b.slice(...(({ start, end }) => [start, end])(find(first.b, first.moov, 'mvhd')));
    const v1 = mvhd[8] === 1;
    const scale = u32(mvhd, v1 ? 28 : 20);
    const dur = durationSec > 0 ? Math.round(durationSec * scale) : 0;
    if (dur) {
      if (v1) { w32(mvhd, 32, Math.floor(dur / 4294967296)); w32(mvhd, 36, dur >>> 0); }
      else w32(mvhd, 24, dur);
    }
    w32(mvhd, v1 ? 116 : 104, tracks.length + 1); // next_track_ID

    const mvex = [];
    if (dur) {
      const mehd = new Uint8Array(8);
      w32(mehd, 4, Math.min(dur, 0xffffffff));
      mvex.push(box('mehd', [mehd]));
    }
    const traks = tracks.map((t, i) => {
      const trex = find(t.b, find(t.b, t.moov, 'mvex'), 'trex');
      const trexCopy = t.b.slice(trex.start, trex.end);
      w32(trexCopy, 12, i + 1);
      mvex.push(trexCopy);

      const trak = t.b.slice(t.trak.start, t.trak.end);
      const tkhd = list(trak, 8, trak.length).find(x => x.type === 'tkhd') || fail();
      const tv1 = trak[tkhd.body] === 1;
      w32(trak, tkhd.body + (tv1 ? 20 : 12), i + 1);
      if (dur) {
        if (tv1) { w32(trak, tkhd.body + 28, Math.floor(dur / 4294967296)); w32(trak, tkhd.body + 32, dur >>> 0); }
        else w32(trak, tkhd.body + 20, dur);
      }
      return trak;
    });

    const parts = [
      box('ftyp', [ascii('isom'), new Uint8Array([0, 0, 2, 0]), ascii('isomiso2iso6avc1mp41')]),
      box('moov', [mvhd, box('mvex', mvex), ...traks]),
    ];
    const frags = tracks
      .flatMap((t, i) => t.frags.map(f => ({ ...f, b: t.b, id: i + 1 })))
      .sort((a, b) => a.time - b.time || a.id - b.id);
    let seq = 1;
    for (const f of frags) {
      w32(f.b, f.tfhd, f.id);
      w32(f.b, f.mfhd, seq++);
      parts.push(f.b.subarray(f.start, f.end));
    }
    return parts;
  }

  return { build };
})();
