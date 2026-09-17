// בדיקת מיזוג מקצה לקצה: קובצי fMP4 -> MP4 רגיל (לא מפוצל),
// ואז ffprobe מאמת שהוא תקין ושהזרמים זהים לביט למקור.
// node test/mux.test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const { execFileSync } = require('child_process');

const ctx = { Uint8Array, String, Math, Array, Error, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../src/mux.js', 'utf8') + ';this.Mux = Mux;', ctx);

const at = n => __dirname + '/' + n;
const read = n => new Uint8Array(fs.readFileSync(at(n)));
const ffprobe = args => execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' }).trim();
const probeJson = f => JSON.parse(ffprobe(['-print_format', 'json', '-show_format', '-show_streams', f]));
// הזרם הגולמי, בלי מכל – כך אפשר להשוות פריימים ישירות
const raw = (file, map, fmt) => execFileSync('ffmpeg',
  ['-v', 'error', '-i', file, '-map', map, '-c', 'copy', '-f', fmt, '-'], { maxBuffer: 1 << 28 });

function topBoxes(buf) {
  const counts = {};
  for (let o = 0; o + 8 <= buf.length;) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(o + 8));
    if (size < 8) break;
    counts[type] = (counts[type] || 0) + 1;
    o += size;
  }
  return counts;
}

function checkMerged(name, videoFile, audioFile, seconds, frames) {
  const outFile = at(`out-${name}.mp4`);
  const merged = Buffer.concat(ctx.Mux.build([read(videoFile), read(audioFile)], seconds).map(Buffer.from));
  fs.writeFileSync(outFile, merged);

  // 1. המבנה: MP4 רגיל, לא מפוצל
  const boxes = topBoxes(merged);
  assert.strictEqual(boxes.moof, undefined, `${name}: אין moof – הקובץ לא מפוצל`);
  assert.strictEqual(boxes.mdat, 1, `${name}: mdat אחד בלבד`);
  assert.strictEqual(boxes.moov, 1);
  assert(!merged.includes(Buffer.from('mvex')), `${name}: mvex הוסר`);
  for (const t of ['stts', 'stsc', 'stsz', 'stco']) {
    assert(merged.includes(Buffer.from(t)), `${name}: ${t} קיים`);
  }

  // 2. ה-moov מצהיר על מספר הפריימים הנכון (בלי לספור בפועל)
  const declared = ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', outFile]);
  assert.strictEqual(declared, String(frames), `${name}: moov מצהיר ${frames}, קיבלנו ${declared}`);

  // 3. שני מסלולים עם מזהים נפרדים, ואורך נכון
  const probe = probeJson(outFile);
  assert.deepStrictEqual(probe.streams.map(s => s.codec_name).sort(), ['aac', 'h264']);
  assert.deepStrictEqual(probe.streams.map(s => s.id).sort(), ['0x1', '0x2']);
  const dur = +probe.format.duration;
  assert(Math.abs(dur - seconds) < 0.3, `${name}: אורך ${dur} אמור להיות ~${seconds}`);

  // 4. הפריימים נקראים בפועל, והקובץ מפוענח במלואו בלי שגיאה
  const counted = ffprobe(['-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', outFile]);
  assert.strictEqual(counted, String(frames), `${name}: ${frames} פריימים בפועל, התקבל ${counted}`);
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', outFile, '-f', 'null', '-'], { stdio: 'pipe' });

  // 5. הקשה מכולן: הזרמים הגולמיים זהים לביט למקור – אין קידוד מחדש
  assert(raw(outFile, '0:v:0', 'h264').equals(raw(at(videoFile), '0:v:0', 'h264')),
    `${name}: זרם הווידאו זהה לביט למקור`);
  assert(raw(outFile, '0:a:0', 'adts').equals(raw(at(audioFile), '0:a:0', 'adts')),
    `${name}: זרם האודיו זהה לביט למקור`);

  const bframes = +ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=has_b_frames', '-of', 'csv=p=0', outFile]);
  const hasCtts = merged.includes(Buffer.from('ctts'));
  console.log(`  ${name}: ${Object.entries(boxes).map(([k, v]) => k + '×' + v).join(' ')} · ` +
    `${dur.toFixed(2)}s · ${frames} פריימים · B-frames=${bframes} · ctts=${hasCtts ? 'כן' : 'לא'} · ` +
    `${(merged.length / 1024).toFixed(0)} KB`);
  return { hasCtts };
}

console.log('מיזוג וידאו + אודיו:');
checkMerged('simple', 'video.mp4', 'audio.m4a', 5, 75);
// עם B-frames הקידוד יוצא מסדר התצוגה, ולכן חייב להיכתב ctts – בדיוק כמו ביוטיוב
const withB = checkMerged('bframes', 'video-b.mp4', 'audio-st.m4a', 8, 200);
assert(withB.hasCtts, 'קובץ עם B-frames חייב לקבל טבלת ctts');

// --- אודיו בלבד: קלט יחיד חייב לעבור גם הוא ---
const only = Buffer.concat(ctx.Mux.build([read('audio.m4a')], 5).map(Buffer.from));
fs.writeFileSync(at('out.m4a'), only);
const b2 = topBoxes(only);
assert.strictEqual(b2.moof, undefined);
assert.strictEqual(b2.mdat, 1);
const p2 = probeJson(at('out.m4a'));
assert.strictEqual(p2.streams.length, 1);
assert.strictEqual(p2.streams[0].codec_name, 'aac');
assert(raw(at('out.m4a'), '0:a:0', 'adts').equals(raw(at('audio.m4a'), '0:a:0', 'adts')),
  'אודיו בלבד: זהה לביט למקור');
console.log('אודיו בלבד: תקין, זהה לביט למקור');
