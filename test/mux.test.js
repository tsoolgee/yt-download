// בדיקת מיזוג מקצה לקצה: שני קובצי fMP4 -> MP4 אחד, ואז ffprobe מאמת שהוא תקין.
// node test/mux.test.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const { execFileSync } = require('child_process');

const ctx = { Uint8Array, String, Math, Array, Error, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../src/mux.js', 'utf8') + ';this.Mux = Mux;', ctx);

const video = new Uint8Array(fs.readFileSync(__dirname + '/video.mp4'));
const audio = new Uint8Array(fs.readFileSync(__dirname + '/audio.m4a'));
const out = __dirname + '/out.mp4';

// --- מיזוג וידאו + אודיו ---
const parts = ctx.Mux.build([video, audio], 5);
const merged = Buffer.concat(parts.map(Buffer.from));
fs.writeFileSync(out, merged);

const probe = JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out,
], { encoding: 'utf8' }));

const streams = probe.streams.map(s => s.codec_name).sort();
assert.deepStrictEqual(streams, ['aac', 'h264'], 'שני מסלולים: h264 + aac');
assert.strictEqual(probe.streams.length, 2);

const dur = +probe.format.duration;
assert(Math.abs(dur - 5) < 0.3, `אורך ${dur} אמור להיות ~5 שניות`);

// כל מסלול קיבל מזהה משלו (1 ו-2), כמו ש-build כותב ב-tkhd
assert.deepStrictEqual(probe.streams.map(s => s.id).sort(), ['0x1', '0x2']);

// הפריימים באמת נקראים – לא רק הכותרת תקינה
const frames = execFileSync('ffprobe', [
  '-v', 'error', '-count_frames', '-select_streams', 'v:0',
  '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out,
], { encoding: 'utf8' }).trim();
assert.strictEqual(frames, '75', `75 פריימים (15fps * 5s), התקבל ${frames}`);

// פענוח מלא של שני המסלולים בלי שגיאה – מגלה offsets שבורים
execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', out, '-f', 'null', '-'], { stdio: 'pipe' });

// --- אודיו בלבד: קלט יחיד חייב לעבור גם הוא ---
const only = Buffer.concat(ctx.Mux.build([audio], 5).map(Buffer.from));
fs.writeFileSync(__dirname + '/out.m4a', only);
const p2 = JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-print_format', 'json', '-show_streams', __dirname + '/out.m4a',
], { encoding: 'utf8' }));
assert.strictEqual(p2.streams.length, 1);
assert.strictEqual(p2.streams[0].codec_name, 'aac');

console.log(`מיזוג תקין: ${streams.join(' + ')}, ${dur.toFixed(2)}s, ${frames} פריימים, ${(merged.length / 1024).toFixed(0)} KB`);
console.log('אודיו בלבד: aac תקין');
