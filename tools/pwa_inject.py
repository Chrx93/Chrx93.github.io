#!/usr/bin/env python3
"""Rende la build web una PWA installabile (manifest + service worker + icone).

Uso: python tools/pwa_inject.py dist
Copia i file da web-pwa/ dentro la cartella di build e inietta i tag nel
<head> di index.html. Idempotente.
"""
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "web-pwa"

HEAD = """<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0a0f1e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="TCG Radar">
<link rel="apple-touch-icon" href="/icon-192.png">
<script>if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script>
"""

MARKER = 'rel="manifest"'


def main():
    dist = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
    if not dist.exists():
        print(f"[pwa] cartella {dist} inesistente"); sys.exit(1)

    for name in ("manifest.webmanifest", "sw.js", "icon.png", "icon-192.png"):
        src = SRC / name
        if src.exists():
            shutil.copy(src, dist / name)
        else:
            print(f"[pwa] manca {src}")

    index = dist / "index.html"
    html = index.read_text(encoding="utf-8")
    if MARKER in html:
        print("[pwa] gia' iniettato"); return
    if "</head>" in html:
        html = html.replace("</head>", HEAD + "</head>", 1)
    else:
        html = HEAD + html
    index.write_text(html, encoding="utf-8")
    print("[pwa] PWA iniettata in", index)


if __name__ == "__main__":
    main()
