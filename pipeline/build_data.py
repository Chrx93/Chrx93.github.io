#!/usr/bin/env python3
"""TCG Radar - generatore di data.json

Fonti prezzi (tutto convertito/mostrato in EURO):
  - Pokemon  -> TCGdex (Cardmarket EUR + TCGplayer USD), gratis, nessuna chiave.
  - One Piece -> eBay USA (se ci sono le chiavi in .env), convertito in EUR
                 al cambio BCE live; immagine/seriale da optcgapi.com.

Storico:
  - history.json tiene una serie temporale [[iso, prezzo], ...] per carta.
    Nel cloud viene mantenuta tra un run e l'altro tramite cache di GitHub
    Actions, cosi' i grafici crescono nel tempo (stile Collectr).

Notizie:
  - Google News RSS su piu' regioni (USA, Europa/IT, Giappone) e piu' tipi
    (news, YouTube/video, Reddit/community), con tag regione e tipo.

Uso:
    py build_data.py            # dati reali dove possibile
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
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).parent
WATCHLIST = ROOT / "watchlist.json"
HISTORY = ROOT / "history.json"
TRANSLATIONS = ROOT / "translations.json"
ARTISTS = ROOT / "artists.json"
OUTPUT = ROOT / "data.json"

HISTORY_LEN = 1500   # punti di storico tenuti per carta (~31 giorni a 30 min)
SPARK_LEN = 8        # punti mostrati nel mini-grafico delle righe
CHART_LEN = 90       # punti massimi messi nel grafico grande (downsample)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TCG-Radar/2.0"
NOW = datetime.datetime.now(datetime.timezone.utc)


def _get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore"))


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
# Cambio USD -> EUR (BCE via frankfurter.app, gratis, nessuna chiave)
# ---------------------------------------------------------------------------
def fetch_usd_eur() -> float:
    try:
        d = _get_json("https://api.frankfurter.app/latest?from=USD&to=EUR", timeout=15)
        rate = float(d["rates"]["EUR"])
        if 0.5 < rate < 1.5:
            return rate
    except Exception as exc:  # noqa: BLE001
        print(f"[TCG Radar] cambio non disponibile ({exc}), uso 0.92")
    return 0.92


USD_EUR = fetch_usd_eur()


def to_eur(usd):
    return round(usd * USD_EUR, 2) if usd is not None else None


# ---------------------------------------------------------------------------
# Fonte: TCGdex (Pokemon) - gratis, nessuna chiave
# ---------------------------------------------------------------------------
def tcgdex_fetch(card_id: str):
    """Prezzo EUR/USD, medie 1/7/30g, immagine e seriale per una carta Pokemon."""
    if not card_id:
        return None
    try:
        c = _get_json(f"https://api.tcgdex.net/v2/en/cards/{card_id}")
    except Exception as exc:  # noqa: BLE001
        print(f"    tcgdex errore per {card_id}: {exc}")
        return None
    if not isinstance(c, dict) or not c.get("id"):
        return None

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

    return {
        "usd": usd,
        "eur": eur,
        "cm_avg1": _eur("avg1"),
        "cm_avg7": _eur("avg7"),
        "cm_avg30": _eur("avg30"),
        "image": image,
        "serial": serial,
        "illustrator": c.get("illustrator"),
    }


def optcg_fetch(code: str):
    """Immagine + dati carta One Piece da optcgapi.com (gratis, nessuna chiave)."""
    if not code:
        return None
    try:
        data = _get_json(f"https://optcgapi.com/api/sets/card/{code}/")
    except Exception as exc:  # noqa: BLE001
        print(f"    optcgapi errore per {code}: {exc}")
        return None
    c = data[0] if isinstance(data, list) and data else (data if isinstance(data, dict) else None)
    if not c:
        return None
    return {"image": c.get("card_image"), "serial": c.get("card_set_id"), "name": c.get("card_name")}


# ---------------------------------------------------------------------------
# Fonte: eBay USA (One Piece) - serve chiave in .env -> prezzo convertito in EUR
# ---------------------------------------------------------------------------
def ebay_token() -> str:
    import requests

    creds = base64.b64encode(f"{EBAY_CLIENT_ID}:{EBAY_CLIENT_SECRET}".encode()).decode()
    resp = requests.post(
        "https://api.ebay.com/identity/v1/oauth2/token",
        headers={"Authorization": f"Basic {creds}", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "client_credentials", "scope": "https://api.ebay.com/oauth/api_scope"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


EBAY_JUNK = (
    "proxy", "fake", "replica", "custom", "orica", " metal ", "bundle",
    "playset", "sleeve", "toploader", "sticker", "poster", "psa", "bgs",
    "cgc", "graded", "sealed", "lot of", " set ", "set of",
)


def _alnum(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def ebay_price_usd(token: str, query: str, code: str = None):
    """Stima prezzo USD da eBay (annunci attivi). Mediana 'trimmed'."""
    import requests

    code_norm = _alnum(code) if code else None
    resp = requests.get(
        "https://api.ebay.com/buy/browse/v1/item_summary/search",
        headers={"Authorization": f"Bearer {token}", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"},
        params={"q": query, "category_ids": "183454", "limit": 100,
                "filter": "buyingOptions:{FIXED_PRICE}"},
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


def ebay_best_offer(token: str, query: str, code: str = None):
    """Annuncio ATTIVO piu' economico su eBay.it (EUR): prezzo, venditore, link."""
    import requests

    code_norm = _alnum(code) if code else None
    try:
        resp = requests.get(
            "https://api.ebay.com/buy/browse/v1/item_summary/search",
            headers={"Authorization": f"Bearer {token}", "X-EBAY-C-MARKETPLACE-ID": "EBAY_IT"},
            params={"q": query, "limit": 50, "sort": "price",
                    "filter": "buyingOptions:{FIXED_PRICE}"},
            timeout=30,
        )
        resp.raise_for_status()
        items = resp.json().get("itemSummaries", []) or []
    except Exception as exc:  # noqa: BLE001
        print(f"    eBay best offer errore: {exc}")
        return None
    best = None
    for it in items:
        title = (it.get("title") or "").lower()
        if any(j in (" " + title + " ") for j in EBAY_JUNK):
            continue
        if code_norm and code_norm not in _alnum(title):
            continue
        price = it.get("price", {})
        if price.get("currency") != "EUR":
            continue
        try:
            val = float(price["value"])
        except (KeyError, ValueError, TypeError):
            continue
        ship = 0.0
        opts = it.get("shippingOptions") or []
        if opts:
            try:
                ship = float((opts[0].get("shippingCost") or {}).get("value") or 0)
            except (ValueError, TypeError):
                ship = 0.0
        total = round(val + ship, 2)
        if best is None or total < best["total"]:
            best = {
                "price": round(val, 2),
                "ship": round(ship, 2),
                "total": total,
                "seller": (it.get("seller") or {}).get("username"),
                "url": it.get("itemWebUrl"),
            }
    return best


def ebay_search_url(query: str) -> str:
    # eBay.it, ordinato dal piu' economico (prezzo + spedizione)
    return "https://www.ebay.it/sch/i.html?_nkw=" + urllib.parse.quote(query) + "&_sop=15"


# ---------------------------------------------------------------------------
# Motore notizie: Google News RSS multi-regione + multi-tipo
# ---------------------------------------------------------------------------
# (etichetta, query, regione, tipo, hl, gl, ceid)
NEWS_FEEDS = [
    ("One Piece US", '"One Piece" card game TCG', "US", "news", "en-US", "US", "US:en"),
    ("Pokemon US", "Pokemon TCG card", "US", "news", "en-US", "US", "US:en"),
    ("Mercato IT", "carte Pokemon One Piece prezzo mercato collezione", "EU", "news", "it-IT", "IT", "IT:it"),
    ("One Piece IT", "One Piece card game carte", "EU", "news", "it-IT", "IT", "IT:it"),
    ("Pokemon JP", "ポケモンカード 高騰 相場", "JP", "news", "ja-JP", "JP", "JP:ja"),
    ("One Piece JP", "ワンピースカード 高騰 相場", "JP", "news", "ja-JP", "JP", "JP:ja"),
    ("YouTube", 'Pokemon OR "One Piece" TCG site:youtube.com', "US", "video", "en-US", "US", "US:en"),
    ("Reddit", 'Pokemon OR "One Piece" TCG site:reddit.com', "US", "forum", "en-US", "US", "US:en"),
    ("eBay trend", 'Pokemon "One Piece" card sold price record', "US", "market", "en-US", "US", "US:en"),
]

PER_FEED = 9


def fetch_news():
    """Notizie reali via Google News RSS (aggrega tanti siti), con regione e tipo."""
    import email.utils
    import xml.etree.ElementTree as ET

    seen = set()
    news = []
    for label, query, region, kind, hl, gl, ceid in NEWS_FEEDS:
        url = ("https://news.google.com/rss/search?q="
               + urllib.parse.quote(query) + f"&hl={hl}&gl={gl}&ceid={ceid}")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as resp:
                root = ET.fromstring(resp.read().decode("utf-8", "ignore"))
        except Exception as exc:  # noqa: BLE001
            print(f"    news '{label}' errore: {exc}")
            continue
        count = 0
        for item in root.findall(".//item"):
            if count >= PER_FEED:
                break
            title_el = item.find("title")
            link_el = item.find("link")
            date_el = item.find("pubDate")
            src_el = item.find("source")
            if title_el is None or not title_el.text:
                continue
            title = title_el.text.strip()
            source = src_el.text.strip() if src_el is not None and src_el.text else "Google News"
            if title.endswith(" - " + source):
                title = title[: -(len(source) + 3)].strip()
            keyt = title.lower()
            if keyt in seen:
                continue
            seen.add(keyt)
            count += 1
            date, time, iso = "", "", None
            if date_el is not None and date_el.text:
                try:
                    dt = email.utils.parsedate_to_datetime(date_el.text)
                    date, time = dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")
                    iso = dt.astimezone(datetime.timezone.utc).isoformat()
                except Exception:  # noqa: BLE001
                    pass
            news.append({
                "id": f"{region}{count}-" + (title[:40] or str(len(news))),
                "title": title,
                "source": source,
                "region": region,
                "kind": kind,
                "date": date,
                "time": time,
                "iso": iso,
                "signal": "HYPE",
                "dir": None,
                "cards": [],
                "summary": "",
                "url": link_el.text if link_el is not None and link_el.text else None,
            })
    news.sort(key=lambda n: (n["iso"] or "", n["date"], n["time"]), reverse=True)
    print(f"[TCG Radar] Notizie: {len(news)} (US/EU/JP, news+video+forum)")
    return news


def card_key(name: str) -> str:
    cleaned = "".join(ch if (ch.isalpha() or ch == " ") else " " for ch in name)
    words = [w for w in cleaned.split() if len(w) >= 4]
    return (max(words, key=len) if words else name).lower()


# ---------------------------------------------------------------------------
# Studio ARTISTI: quali illustratori hanno le carte di maggior valore.
# Campiona i rari (numeri alti) dei set Pokémon recenti, prende illustratore +
# prezzo Cardmarket, aggrega per artista. Dati reali; cresce nel tempo (cache).
# ---------------------------------------------------------------------------
def build_artists(max_fetch: int = 110):
    try:
        sets = _get_json("https://api.tcgdex.net/v2/en/sets")
    except Exception as exc:  # noqa: BLE001
        print(f"    artisti: lista set errore: {exc}")
        return []
    if not isinstance(sets, list):
        return []
    recent = [s for s in sets if (s.get("cardCount") or {}).get("official")][-16:]

    def num_of(c):
        digits = "".join(ch for ch in str(c.get("localId", "")) if ch.isdigit())
        try:
            return int(digits) if digits else 0
        except ValueError:
            return 0

    by_art = {}
    fetched = 0
    for s in reversed(recent):
        if fetched >= max_fetch:
            break
        try:
            full = _get_json(f"https://api.tcgdex.net/v2/en/sets/{s['id']}")
        except Exception:  # noqa: BLE001
            continue
        cards = sorted(full.get("cards") or [], key=num_of, reverse=True)[:10]
        for c in cards:
            if fetched >= max_fetch:
                break
            try:
                fc = _get_json(f"https://api.tcgdex.net/v2/en/cards/{c['id']}")
            except Exception:  # noqa: BLE001
                continue
            fetched += 1
            ill = fc.get("illustrator")
            price = ((fc.get("pricing") or {}).get("cardmarket") or {}).get("trend")
            if not ill or not price:
                continue
            img = fc.get("image")
            key = ill.strip().lower()  # accorpa "Takuyoa" e "takuyoa"
            entry = by_art.setdefault(key, {"name": ill, "cards": []})
            entry["cards"].append({
                "id": fc.get("id"), "name": fc.get("name"), "price": round(price, 2),
                "image": (img + "/low.png") if img else None,
                "set": (fc.get("set") or {}).get("name", ""),
            })

    artists = []
    for entry in by_art.values():
        cards = entry["cards"]
        if len(cards) < 2:  # serve un pattern: almeno 2 carte di valore
            continue
        cards.sort(key=lambda x: x["price"], reverse=True)
        prices = [c["price"] for c in cards]
        artists.append({
            "name": entry["name"], "count": len(cards),
            "avg": round(sum(prices) / len(prices), 2), "max": max(prices),
            "cards": cards[:6],
        })
    artists.sort(key=lambda a: (a["avg"], a["count"]), reverse=True)
    print(f"[TCG Radar] Artisti: {len(artists)} con 2+ carte (da {fetched} campionate)")
    return artists[:15]


# ---------------------------------------------------------------------------
# Traduzione titoli notizie -> italiano (Google translate gtx, gratis, no key)
# ---------------------------------------------------------------------------
def translate_it(text: str, cache: dict):
    """Traduce in italiano. Usa la cache per non ritradurre titoli gia' visti."""
    if not text:
        return None
    if text in cache:
        return cache[text]
    try:
        url = ("https://translate.googleapis.com/translate_a/single?client=gtx"
               "&sl=auto&tl=it&dt=t&q=" + urllib.parse.quote(text))
        data = _get_json(url, timeout=15)
        segs = data[0] if isinstance(data, list) and data else None
        if not segs:
            return None
        out = "".join(s[0] for s in segs if isinstance(s, list) and s and s[0]).strip()
        if out:
            cache[text] = out
            return out
    except Exception as exc:  # noqa: BLE001
        print(f"    traduzione errore: {exc}")
    return None


# ---------------------------------------------------------------------------
# Storico (serie temporale [[iso, prezzo], ...])
# ---------------------------------------------------------------------------
def load_history() -> dict:
    if HISTORY.exists():
        try:
            return json.loads(HISTORY.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def normalize_series(raw):
    """Accetta sia il vecchio formato [num, num] sia il nuovo [[iso, num]]."""
    out = []
    for p in raw or []:
        if isinstance(p, list) and len(p) == 2:
            out.append([p[0], float(p[1])])
        elif isinstance(p, (int, float)):
            out.append([None, float(p)])
    return out


def seed_series(target: float, days: int = 14):
    """Storico di 'rodaggio' timestampato: termina sul prezzo reale di oggi.

    Volatilita' MOLTO bassa di proposito: finche' non si accumula storico reale,
    il seed deve restare quasi piatto per NON generare falsi segnali di momentum
    (radar / 'In rampa'). Il momentum vero emerge man mano coi dati reali.
    """
    random.seed(str(target))
    prices = [round(target, 2)]
    p = target
    for _ in range(days - 1):
        p = p / random.uniform(0.993, 1.007)
        prices.append(round(p, 2))
    prices.reverse()
    out = []
    n = len(prices)
    for i, pr in enumerate(prices):
        t = NOW - datetime.timedelta(days=(n - 1 - i))
        out.append([t.isoformat(), pr])
    return out


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(s)
    except Exception:  # noqa: BLE001
        return None


def change_over(series, days):
    """Variazione % sugli ultimi `days` giorni, dai timestamp della serie."""
    pts = [(parse_ts(t), v) for t, v in series if t]
    if len(pts) < 2:
        return None
    last_t, last_v = pts[-1]
    target = last_t - datetime.timedelta(days=days)
    base = None
    for t, v in pts:
        if t <= target:
            base = v
        else:
            break
    if base is None:
        base = pts[0][1]
    if not base:
        return None
    return round((last_v - base) / base * 100, 1)


def change_simple(series):
    if len(series) < 2:
        return 0.0
    old = series[0][1]
    new = series[-1][1]
    return round((new - old) / old * 100, 1) if old else 0.0


def downsample(series, n=CHART_LEN):
    if len(series) <= n:
        return series
    step = len(series) / n
    out = [series[int(i * step)] for i in range(n)]
    out[-1] = series[-1]
    return out


# ---------------------------------------------------------------------------
# DEMO
# ---------------------------------------------------------------------------
def demo_base_series(ref, base):
    random.seed(ref)
    return seed_series(round(base * random.uniform(0.9, 1.1), 2))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    watchlist = json.loads(WATCHLIST.read_text(encoding="utf-8"))
    cards = watchlist.get("cards", [])
    news = fetch_news() or watchlist.get("news", [])

    # Traduci in italiano i titoli delle notizie USA e Giappone (Europa e' gia' IT)
    translations = {}
    if TRANSLATIONS.exists():
        try:
            translations = json.loads(TRANSLATIONS.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            translations = {}
    tcount = 0
    for n in news:
        if n.get("region") in ("US", "JP") and n.get("title"):
            was_cached = n["title"] in translations
            it = translate_it(n["title"], translations)
            if it and it.lower() != n["title"].lower():
                n["titleIt"] = it
                tcount += 1
            if not was_cached:
                time.sleep(0.12)  # gentile con l'endpoint
    TRANSLATIONS.write_text(json.dumps(translations, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[TCG Radar] Titoli tradotti in IT: {tcount}/{sum(1 for n in news if n.get('region') in ('US','JP'))}")

    print(f"[TCG Radar] {len(cards)} carte | eBay: {'ON' if HAVE_EBAY else 'OFF'} | "
          f"cambio USD->EUR {USD_EUR:.4f} | {'DEMO' if FORCE_DEMO else 'reale dove possibile'}")

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
        game = card.get("game")
        series = normalize_series(history.get(ref, []))

        eur = None
        image = card.get("image")
        serial = card.get("serial") or ref
        source = "demo"
        cm_tf = None  # variazioni Cardmarket reali (Pokemon)
        best_offer = None  # annuncio piu' economico su eBay.it
        illustrator = None

        # --- Pokemon: TCGdex (Cardmarket EUR) ---
        if game == "pokemon" and card.get("pokemontcg_id") and not FORCE_DEMO:
            info = tcgdex_fetch(card["pokemontcg_id"])
            if info and (info["usd"] is not None or info["eur"] is not None):
                usd, e = info["usd"], info["eur"]
                if usd and e and (e > usd * 5 or usd > e * 5):
                    e = None  # Cardmarket rumoroso sulle comuni economiche
                eur = e if e is not None else to_eur(usd)
                image = info["image"] or image
                serial = info["serial"] or serial
                illustrator = info.get("illustrator")
                source = "tcgdex"
                if eur and eur >= 5:
                    def _chg(avg, t=eur):
                        if not avg:
                            return None
                        v = round((t - avg) / avg * 100, 1)
                        # le medie a 7g di Cardmarket su carte poco liquide sono
                        # rumorose: oltre il 30% e' quasi sempre rumore, non un
                        # movimento reale -> scarto (cade sullo storico vero).
                        return v if abs(v) <= 30 else None
                    cm_tf = {"d1": _chg(info["cm_avg1"]), "d7": _chg(info["cm_avg7"]),
                             "d30": _chg(info["cm_avg30"])}

        # --- One Piece: eBay USA -> EUR ---
        elif game == "onepiece" and token is not None:
            usd = ebay_price_usd(token, card.get("ebay_query", card["name"]), card.get("ebay_code"))
            if usd is not None:
                eur = to_eur(usd)
                source = "eBay->EUR"
            best_offer = ebay_best_offer(token, card.get("ebay_query", card["name"]), card.get("ebay_code"))

        # immagine + seriale One Piece da optcgapi
        if game == "onepiece":
            oc = optcg_fetch(card.get("ebay_code"))
            if oc:
                image = oc["image"] or image
                serial = oc["serial"] or serial

        # --- aggiorna lo storico (in EUR) ---
        if eur is None:
            if not series:
                series = demo_base_series(ref, card.get("demo_base", 10))
            else:
                last = series[-1][1]
                eur = round(last * random.uniform(0.997, 1.003), 2)
                series.append([NOW.isoformat(), eur])
            eur = series[-1][1]
            source = "demo" if source == "demo" else source
        else:
            if not series:
                series = seed_series(eur)
            else:
                series.append([NOW.isoformat(), eur])

        series = series[-HISTORY_LEN:]
        history[ref] = series

        # --- variazioni ---
        tf = cm_tf or {
            "d1": change_over(series, 1),
            "d7": change_over(series, 7),
            "d30": change_over(series, 30),
        }
        ch = tf.get("d7")
        if ch is None:
            ch = change_simple(series[-SPARK_LEN:])
        changes.append(ch)

        spark = [round(v, 2) for _, v in series[-SPARK_LEN:]]
        chart = downsample(series, CHART_LEN)

        # minimo/massimo dello storico accumulato (per "posizione" nel dettaglio)
        rng = None
        vals = [v for _, v in series]
        if len(vals) >= 3:
            rng = {"low": round(min(vals), 2), "high": round(max(vals), 2), "days": len(vals)}

        # link d'acquisto (ricerca ordinata dal piu' economico dove possibile)
        nm = card["name"]
        ct_url = "https://www.cardtrader.com/en/search?q=" + urllib.parse.quote(nm)
        if game == "onepiece":
            q = card.get("ebay_query", nm)
            cm_url = "https://www.cardmarket.com/en/OnePiece/Products/Search?searchString=" + urllib.parse.quote(nm)
            ebay_url = ebay_search_url(q)
            vinted_url = ("https://www.vinted.it/catalog?order=price_low_to_high&search_text="
                          + urllib.parse.quote(f"{nm} {card.get('ebay_code','')}"))
            auction_q = q
        else:
            cm_url = "https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=" + urllib.parse.quote(nm)
            ebay_url = ebay_search_url(f"{nm} {serial} pokemon card")
            vinted_url = ("https://www.vinted.it/catalog?order=price_low_to_high&search_text="
                          + urllib.parse.quote(f"{nm} pokemon {serial}"))
            auction_q = f"{nm} {serial} pokemon card"
        # aste in corso, in chiusura per prime
        auction_url = ("https://www.ebay.it/sch/i.html?_nkw=" + urllib.parse.quote(auction_q)
                       + "&LH_Auction=1&_sop=1")

        items.append({
            "ref": ref,
            "name": nm,
            "game": game,
            "set": card.get("set", ""),
            "rarity": card.get("rarity", "—"),
            "serial": serial,
            "image": image,
            "change7d": ch,
            "tf": tf,
            "prices": {"eu": eur},
            "history": spark,
            "chart": chart,
            "note": card.get("note", ""),
            "signal": card.get("signal", "FATTO"),
            "buyUrl": ebay_url,
            "buyLinks": {"cardmarket": cm_url, "ebay": ebay_url, "cardtrader": ct_url,
                         "vinted": vinted_url, "auction": auction_url},
            "bestOffer": best_offer,
            "illustrator": illustrator,
            "range": rng,
        })
        print(f"  - {ref:24} {('EUR '+format(eur,'.2f')) if eur is not None else '--':>12} ({source:11}) {ch:+.1f}% 7g")

    market_pulse = round(statistics.mean(changes), 1) if changes else 0.0

    # --- Radar: pool ampio (top 12) che la app fa ruotare in Home ---
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
        if not reasons:
            reasons.append("da tenere d'occhio")
        item["inNews"] = in_news
        item["radarReason"] = " · ".join(reasons)
        radar.append((mom + (15 if in_news else 0), item["ref"]))
    radar.sort(reverse=True)
    radar_refs = [r for _, r in radar[:12]]

    for n in news:
        t = n["title"].lower()
        n["cards"] = [item["ref"] for item in items if card_key(item["name"]) in t]

    # Studio artisti (con cache: se il campionamento fallisce, riuso l'ultimo buono)
    artists = build_artists() if not FORCE_DEMO else []
    if not artists and ARTISTS.exists():
        try:
            artists = json.loads(ARTISTS.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            artists = []
    if artists:
        ARTISTS.write_text(json.dumps(artists, ensure_ascii=False, indent=2), encoding="utf-8")

    data = {
        "lastUpdate": NOW.isoformat(),
        "marketPulse": market_pulse,
        "fxUsdEur": USD_EUR,
        "radar": radar_refs,
        "items": items,
        "news": news,
        "artists": artists,
    }

    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    HISTORY.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[TCG Radar] Scritto {OUTPUT.name} (pulse {market_pulse:+.1f}%) e {HISTORY.name}")


if __name__ == "__main__":
    main()
