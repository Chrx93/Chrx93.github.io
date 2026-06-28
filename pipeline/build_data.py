#!/usr/bin/env python3
"""TCG Radar - generatore di data.json

Fonti prezzi:
  - Pokemon  -> pokemontcg.io (GRATIS, nessuna chiave): prezzo USD, immagine,
                numero di serie e link d'acquisto.
  - One Piece -> eBay USA (se ci sono le chiavi in .env), altrimenti DEMO.
                Link d'acquisto = ricerca eBay.

Aggiorna lo storico in history.json e scrive data.json nel formato dell'app.

Uso:
    py build_data.py            # dati reali dove possibile (Pokemon subito)
    py build_data.py --demo     # forza tutto in modalita' demo
"""

import base64
import datetime
import json
import os
import pathlib
import random
import statistics
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).parent
WATCHLIST = ROOT / "watchlist.json"
HISTORY = ROOT / "history.json"
OUTPUT = ROOT / "data.json"

HISTORY_LEN = 30   # punti di storico tenuti per carta
SPARK_LEN = 7      # punti mostrati nel mini-grafico


# ---------------------------------------------------------------------------
# Config / chiavi
# ---------------------------------------------------------------------------
def load_dotenv(path: pathlib.Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


load_dotenv(ROOT / ".env")

EBAY_CLIENT_ID = os.environ.get("EBAY_CLIENT_ID")
EBAY_CLIENT_SECRET = os.environ.get("EBAY_CLIENT_SECRET")

FORCE_DEMO = "--demo" in sys.argv
HAVE_EBAY = bool(EBAY_CLIENT_ID and EBAY_CLIENT_SECRET) and not FORCE_DEMO


# ---------------------------------------------------------------------------
# Fonte: pokemontcg.io  (Pokemon) - gratis, nessuna chiave
# ---------------------------------------------------------------------------
def tcgdex_fetch(card_id: str):
    """Prezzo USD/EUR, medie 1/7/30g, immagine e seriale per una carta Pokemon (TCGdex)."""
    if not card_id:
        return None
    req = urllib.request.Request(
        f"https://api.tcgdex.net/v2/en/cards/{card_id}",
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TCG-Radar/1.0",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            c = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"    tcgdex errore per {card_id}: {exc}")
        return None

    if not isinstance(c, dict) or not c.get("id"):
        return None

    # Prezzo USD = marketPrice di TCGplayer
    usd = None
    tp = (c.get("pricing") or {}).get("tcgplayer") or {}
    for variant in ("holofoil", "normal", "reverse-holofoil", "1st-edition-holofoil"):
        v = tp.get(variant)
        if isinstance(v, dict) and v.get("marketPrice"):
            usd = round(v["marketPrice"], 2)
            break
    if usd is None:
        for v in tp.values():
            if isinstance(v, dict) and v.get("marketPrice"):
                usd = round(v["marketPrice"], 2)
                break

    # EUR di Cardmarket + medie 1/7/30 giorni
    cm = (c.get("pricing") or {}).get("cardmarket") or {}

    def _eur(key):
        v = cm.get(key)
        return round(v, 2) if v else None

    eur = _eur("trend")

    set_obj = c.get("set") or {}
    total = (set_obj.get("cardCount") or {}).get("official")
    local = c.get("localId", "")
    serial = f"{local}/{total}" if total else str(local)
    image = c.get("image")
    image = (image + "/high.png") if image else None
    buy_url = ("https://www.tcgplayer.com/search/pokemon/product?q="
               + urllib.parse.quote(c.get("name", "")))

    return {
        "usd": usd,
        "eur": eur,
        "cm_avg1": _eur("avg1"),
        "cm_avg7": _eur("avg7"),
        "cm_avg30": _eur("avg30"),
        "image": image,
        "serial": serial,
        "buy_url": buy_url,
    }


def optcg_fetch(code: str):
    """Immagine + dati carta One Piece da optcgapi.com (gratis, nessuna chiave)."""
    if not code:
        return None
    req = urllib.request.Request(
        f"https://optcgapi.com/api/sets/card/{code}/",
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TCG-Radar/1.0",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"    optcgapi errore per {code}: {exc}")
        return None
    c = data[0] if isinstance(data, list) and data else (data if isinstance(data, dict) else None)
    if not c:
        return None
    return {"image": c.get("card_image"), "serial": c.get("card_set_id"), "name": c.get("card_name")}


# ---------------------------------------------------------------------------
# Fonte: eBay USA (One Piece e altro) - serve chiave in .env
# ---------------------------------------------------------------------------
def ebay_token() -> str:
    import requests

    creds = base64.b64encode(
        f"{EBAY_CLIENT_ID}:{EBAY_CLIENT_SECRET}".encode()
    ).decode()
    resp = requests.post(
        "https://api.ebay.com/identity/v1/oauth2/token",
        headers={
            "Authorization": f"Basic {creds}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "client_credentials",
            "scope": "https://api.ebay.com/oauth/api_scope",
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


# Parole che indicano annunci da scartare (gradate, lotti, accessori, falsi)
EBAY_JUNK = (
    "proxy", "fake", "replica", "custom", "orica", " metal ", "bundle",
    "playset", "sleeve", "toploader", "sticker", "poster", "psa", "bgs",
    "cgc", "graded", "sealed", "lot of", " set ", "set of",
)


def _alnum(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def ebay_price(token: str, query: str, code: str = None):
    """Stima prezzo USD da eBay (annunci attivi, asking).

    - categoria 'CCG Individual Cards' (carte singole)
    - tiene SOLO gli annunci il cui titolo contiene davvero il codice carta
      (es. OP16-073, in qualsiasi formato) -> niente altre carte mescolate
    - scarta gradate/lotti/accessori per parola chiave
    - mediana 'trimmed' (scarta 20% sotto e 20% sopra) per robustezza agli outlier
    """
    import requests

    code_norm = _alnum(code) if code else None

    resp = requests.get(
        "https://api.ebay.com/buy/browse/v1/item_summary/search",
        headers={
            "Authorization": f"Bearer {token}",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        params={
            "q": query,
            "category_ids": "183454",  # CCG Individual Cards
            "limit": 100,
            "filter": "buyingOptions:{FIXED_PRICE}",
        },
        timeout=30,
    )
    resp.raise_for_status()
    items = resp.json().get("itemSummaries", []) or []
    prices = []
    for it in items:
        title = (it.get("title") or "").lower()
        if any(j in (" " + title + " ") for j in EBAY_JUNK):
            continue
        if code_norm and code_norm not in _alnum(title):
            continue
        price = it.get("price", {})
        if price.get("currency") == "USD":
            try:
                prices.append(float(price["value"]))
            except (KeyError, ValueError, TypeError):
                pass
    if not prices:
        return None
    prices.sort()
    n = len(prices)
    core = prices[int(n * 0.2):int(n * 0.8)] if n >= 6 else prices
    return round(statistics.median(core or prices), 2)


def ebay_search_url(query: str) -> str:
    return "https://www.ebay.com/sch/i.html?_nkw=" + urllib.parse.quote(query)


# ---------------------------------------------------------------------------
# Motore notizie: Google News RSS (gratis, affidabile, multi-fonte)
# ---------------------------------------------------------------------------
GOOGLE_NEWS_QUERIES = [
    ("One Piece TCG", "One Piece card game TCG"),
    ("Pokemon TCG", "Pokemon TCG card"),
    ("Mercato carte", "trading card game prices investing"),
]


def fetch_news():
    """Notizie reali via Google News RSS (aggrega tanti siti, nessuna chiave)."""
    import email.utils
    import xml.etree.ElementTree as ET

    seen = set()
    news = []
    for label, query in GOOGLE_NEWS_QUERIES:
        url = ("https://news.google.com/rss/search?q="
               + urllib.parse.quote(query) + "&hl=en-US&gl=US&ceid=US:en")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 TCG-Radar/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                root = ET.fromstring(resp.read().decode("utf-8", "ignore"))
        except Exception as exc:  # noqa: BLE001
            print(f"    news '{label}' errore: {exc}")
            continue
        for item in root.findall(".//item")[:8]:
            title_el = item.find("title")
            link_el = item.find("link")
            date_el = item.find("pubDate")
            src_el = item.find("source")
            if title_el is None or not title_el.text:
                continue
            title = title_el.text.strip()
            source = src_el.text.strip() if src_el is not None and src_el.text else "Google News"
            if title.endswith(" - " + source):  # il titolo Google News e' "Headline - Fonte"
                title = title[: -(len(source) + 3)].strip()
            if title in seen:
                continue
            seen.add(title)
            date, time = "", ""
            if date_el is not None and date_el.text:
                try:
                    dt = email.utils.parsedate_to_datetime(date_el.text)
                    date, time = dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")
                except Exception:  # noqa: BLE001
                    pass
            news.append({
                "id": title[:48] or f"n{len(news)}",
                "title": title,
                "source": source,
                "date": date,
                "time": time,
                "signal": "HYPE",
                "dir": None,
                "cards": [],
                "summary": "",
                "url": link_el.text if link_el is not None and link_el.text else None,
            })
    news.sort(key=lambda n: (n["date"], n["time"]), reverse=True)
    print(f"[TCG Radar] Notizie: {len(news)} da Google News")
    return news[:25]


def card_key(name: str) -> str:
    """Parola piu' distintiva del nome carta (per cercarla nei titoli delle notizie)."""
    cleaned = "".join(ch if (ch.isalpha() or ch == " ") else " " for ch in name)
    words = [w for w in cleaned.split() if len(w) >= 4]
    return (max(words, key=len) if words else name).lower()


# ---------------------------------------------------------------------------
# DEMO
# ---------------------------------------------------------------------------
def demo_seed_history(ref: str, base: float) -> list:
    random.seed(ref)
    price = base * random.uniform(0.9, 1.0)
    walk = []
    for _ in range(SPARK_LEN):
        price *= random.uniform(0.97, 1.05)
        walk.append(round(price, 2))
    return walk


def demo_next(prev: float) -> float:
    return round(prev * random.uniform(0.96, 1.05), 2)


def seed_history_to(target: float, n: int = SPARK_LEN) -> list:
    """Storico di 'rodaggio': n punti che TERMINANO sul prezzo reale di oggi.

    Serve solo finche' non si accumula lo storico vero, giorno per giorno.
    L'ultimo punto e' sempre il prezzo reale; quelli prima sono stime.
    """
    random.seed(str(target))
    pts = [round(target, 2)]
    p = target
    for _ in range(n - 1):
        p = p / random.uniform(0.97, 1.05)
        pts.append(round(p, 2))
    pts.reverse()
    return pts


# ---------------------------------------------------------------------------
# Storico
# ---------------------------------------------------------------------------
def load_history() -> dict:
    if HISTORY.exists():
        try:
            return json.loads(HISTORY.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def change_7d(series: list) -> float:
    if len(series) < 2:
        return 0.0
    old = series[-8] if len(series) >= 8 else series[0]
    new = series[-1]
    if not old:
        return 0.0
    return round((new - old) / old * 100, 1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    watchlist = json.loads(WATCHLIST.read_text(encoding="utf-8"))
    cards = watchlist.get("cards", [])
    news = fetch_news() or watchlist.get("news", [])

    print(f"[TCG Radar] {len(cards)} carte | eBay: {'ON' if HAVE_EBAY else 'OFF'} | "
          f"{'DEMO forzato' if FORCE_DEMO else 'reale dove possibile'}")

    token = None
    if HAVE_EBAY:
        try:
            token = ebay_token()
            print("[TCG Radar] Token eBay ottenuto.")
        except Exception as exc:  # noqa: BLE001
            print(f"[TCG Radar] eBay non disponibile ({exc}).")

    history = load_history()
    items = []
    changes = []

    for card in cards:
        ref = card["ref"]
        series = history.get(ref, [])
        game = card.get("game")

        prices = {"jp": None, "us": None, "eu": None}
        image = card.get("image")
        serial = card.get("serial") or ref
        buy_url = card.get("buy_url")
        source = "demo"
        tf = None        # variazioni 1g/7g/30g (in EUR, da Cardmarket)
        coarse = None    # storico reale "coarse" per i Pokemon

        # --- Pokemon: pokemontcg.io ---
        if game == "pokemon" and card.get("pokemontcg_id") and not FORCE_DEMO:
            info = tcgdex_fetch(card["pokemontcg_id"])
            if info and (info["usd"] is not None or info["eur"] is not None):
                usd, eur = info["usd"], info["eur"]
                # Se EUR (Cardmarket) e USD (TCGplayer) divergono oltre 5x, l'EUR
                # e' rumoroso (tipico delle comuni economiche) -> lo scarto.
                if usd and eur and (eur > usd * 5 or usd > eur * 5):
                    eur = None
                prices["us"] = usd
                prices["eu"] = eur
                image = info["image"] or image
                serial = info["serial"] or serial
                buy_url = info["buy_url"] or buy_url
                source = "tcgdex"
                trend = eur
                # le medie Cardmarket sono affidabili solo sopra qualche euro
                if trend and trend >= 2:
                    def _chg(avg, t=trend):
                        return round((t - avg) / avg * 100, 1) if avg else None
                    tf = {
                        "d1": _chg(info["cm_avg1"]),
                        "d7": _chg(info["cm_avg7"]),
                        "d30": _chg(info["cm_avg30"]),
                    }
                    # storico coarse ma REALE (escludo avg1, troppo rumoroso): avg30 -> avg7 -> oggi
                    coarse = [x for x in (info["cm_avg30"], info["cm_avg7"], trend) if x is not None]

        # --- One Piece (e altri): eBay ---
        elif game == "onepiece" and token is not None:
            p = ebay_price(token, card.get("ebay_query", card["name"]), card.get("ebay_code"))
            if p is not None:
                prices["us"] = p
                source = "eBay"

        # link d'acquisto di riserva per One Piece (ricerca eBay)
        if buy_url is None and game == "onepiece":
            buy_url = ebay_search_url(card.get("ebay_query", card["name"]))

        # Immagine + seriale One Piece da optcgapi (gratis)
        if game == "onepiece":
            oc = optcg_fetch(card.get("ebay_code"))
            if oc:
                image = oc["image"] or image
                serial = oc["serial"] or serial

        # prezzo principale (US -> EU -> JP)
        primary = prices["us"] or prices["eu"] or prices["jp"]

        # --- storico + variazione 7g ---
        if coarse and len(coarse) >= 2:
            # Pokemon con dati Cardmarket: storico coarse reale, 7g dal periodo EUR
            series = coarse
            ch = tf["d7"] if (tf and tf.get("d7") is not None) else change_7d(series)
        elif primary is None:
            # nessuna fonte reale -> demo
            if not series:
                series = demo_seed_history(ref, card.get("demo_base", 10))
            else:
                series.append(demo_next(series[-1]))
            primary = series[-1]
            prices["us"] = primary
            source = "demo"
            ch = change_7d(series)
        else:
            if not series:
                series = seed_history_to(primary)
            else:
                series.append(primary)
            ch = change_7d(series)

        series = series[-HISTORY_LEN:]
        history[ref] = series
        if ch is None:
            ch = 0.0
        changes.append(ch)
        spark = series[-SPARK_LEN:] if len(series) >= 2 else (series or [0, 0])

        items.append({
            "ref": ref,
            "name": card["name"],
            "set": card.get("set", ""),
            "rarity": card.get("rarity", "—"),
            "serial": serial,
            "image": image,
            "change7d": ch,
            "tf": tf,
            "prices": prices,
            "history": spark,
            "note": card.get("note", ""),
            "signal": card.get("signal", "FATTO"),
            "buyUrl": buy_url,
        })
        disp = primary if primary is not None else (series[-1] if series else 0)
        print(f"  - {ref:24} {disp:>10} ({source:13}) {ch:+.1f}% 7g")

    market_pulse = round(statistics.mean(changes), 1) if changes else 0.0

    # --- Radar / Opportunita' (segnale: momentum positivo + presenza nelle notizie) ---
    titles = [n["title"].lower() for n in news]
    radar = []
    for item in items:
        key = card_key(item["name"])
        in_news = any(key in t for t in titles)
        mom = item["change7d"]
        reasons = []
        if mom >= 5:
            reasons.append(f"+{mom:.0f}% 7g")
        if in_news:
            reasons.append("nelle notizie")
        item["inNews"] = in_news
        if reasons:
            item["radarReason"] = " · ".join(reasons)
            radar.append((mom + (15 if in_news else 0), item["ref"]))
    radar.sort(reverse=True)
    radar_refs = [r for _, r in radar[:6]]

    # collega ogni notizia alle carte citate nel titolo
    for n in news:
        t = n["title"].lower()
        n["cards"] = [item["ref"] for item in items if card_key(item["name"]) in t]

    data = {
        "lastUpdate": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "marketPulse": market_pulse,
        "radar": radar_refs,
        "items": items,
        "news": news,
    }

    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    HISTORY.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[TCG Radar] Scritto {OUTPUT.name} (pulse {market_pulse:+.1f}%) e {HISTORY.name}")


if __name__ == "__main__":
    main()
