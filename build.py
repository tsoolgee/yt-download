"""בונה את התוסף ואת סקריפט הטמפרמונקי מתוך src/.

python build.py  ->  extension/                  (לטעינה ב-chrome://extensions)
                     userscript/yt-download.user.js
                     dist/yt-download.zip
"""
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "src"
EXT = ROOT / "extension"
US = ROOT / "userscript"
DIST = ROOT / "dist"

# הסדר חשוב: הכול חולק scope אחד בתוך IIFE, ו-main.js רץ בסוף.
# vendor/ נטען לפני mp3.js שמשתמש בו. lame.min.js הוא LGPL-3.0 – נשמר
# כקובץ נפרד ב-vendor/ ומיוחס ב-README (lame.sourceforge.net).
BUNDLE = ["src/util.js", "src/mux.js", "src/yt.js",
          "vendor/lame.min.js", "src/mp3.js",
          "src/ui.js", "src/main.js"]

MATCHES = ["https://www.youtube.com/*", "https://m.youtube.com/*", "https://music.youtube.com/*"]

REPO = "tsoolgee/yt-download"
RAW = f"https://raw.githubusercontent.com/{REPO}/main"
# טמפרמונקי בודק את @updateURL ומושך מ-@downloadURL. שניהם מצביעים על main,
# כך שכל דחיפה מגיעה למשתמשים בלי לפרסם גרסה.
USER_JS = f"{RAW}/userscript/yt-download.user.js"


def body():
    return "\n".join((ROOT / n).read_text(encoding="utf-8").strip() + "\n" for n in BUNDLE)


def wrap(code):
    return "(() => {\n'use strict';\n\n" + code + "\n})();\n"


def header(m):
    # @grant none – הסקריפט רץ בהקשר של הדף עצמו, כמו content script ב-world: MAIN.
    # בלי זה אין גישה ל-ytcfg ואין fetch מאותו origin.
    lines = [
        ("name", m["name"]),
        ("namespace", "https://tsoolgee.uk"),
        ("version", m["version"]),
        ("description", m["description"]),
        ("author", m["author"]),
        ("homepage", m["homepage_url"]),
        *[("match", x) for x in MATCHES],
        ("icon", f"{RAW}/src/icons/48.png"),
        ("updateURL", USER_JS),
        ("downloadURL", USER_JS),
        ("supportURL", f"https://github.com/{REPO}/issues"),
        ("run-at", "document-start"),
        ("grant", "none"),
        ("noframes", ""),
    ]
    width = max(len(k) for k, _ in lines)
    out = ["// ==UserScript=="]
    out += [f"// @{k.ljust(width)} {v}".rstrip() for k, v in lines]
    out += ["// ==/UserScript==", ""]
    return "\n".join(out)


def main():
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    code = body()

    # --- תוסף ---
    if EXT.exists():
        shutil.rmtree(EXT)
    (EXT / "icons").mkdir(parents=True)
    (EXT / "content.js").write_text(wrap(code), encoding="utf-8")
    shutil.copy(SRC / "manifest.json", EXT / "manifest.json")
    for png in (SRC / "icons").glob("*.png"):
        shutil.copy(png, EXT / "icons" / png.name)

    # --- טמפרמונקי ---
    US.mkdir(exist_ok=True)
    user_js = US / "yt-download.user.js"
    user_js.write_text(header(manifest) + wrap(code), encoding="utf-8")

    # --- zip ---
    DIST.mkdir(exist_ok=True)
    zip_path = DIST / "yt-download.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(EXT.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(EXT))

    v = manifest["version"]
    print(f"v{v}")
    print(f"  extension/content.js          {(EXT / 'content.js').stat().st_size / 1024:6.1f} KB")
    print(f"  userscript/yt-download.user.js {user_js.stat().st_size / 1024:5.1f} KB")
    print(f"  dist/yt-download.zip          {zip_path.stat().st_size / 1024:6.1f} KB")


if __name__ == "__main__":
    main()
