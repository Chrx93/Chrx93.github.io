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
from concurrent.futures import ThreadPoolExecutor
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
ARTISTS_HIST = ROOT / "artists_hist.json"  # {artista: [[iso, media], ...]} trend nel tempo
SIGNALS = ROOT / "signals.json"
PSA10 = ROOT / "psa10.json"                # cache stime PSA 10 (eBay), riuso tra i run
PULSE_HIST = ROOT / "pulse_hist.json"      # [[iso, marketPulse], ...] polso del mercato nel tempo
DEALS_HIST = ROOT / "deals_hist.json"      # {ref: [date, ...]} giorni in cui la carta era sotto mercato
SPREADS_HIST = ROOT / "spreads_hist.json"  # {ref: [[date, ratio], ...]} spread base<->premium nel tempo
OUTPUT = ROOT / "data.json"

HISTORY_LEN = 1500   # punti di storico tenuti per carta (~31 giorni a 30 min)
SPARK_LEN = 8        # punti mostrati nel mini-grafico delle righe
CHART_LEN = 90       # punti massimi messi nel grafico grande (downsample)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TCG-Radar/2.0"
NOW = datetime.datetime.now(datetime.timezone.utc)


def _get_json(url, timeout=12):
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
    """Immagine + dati carta One Piece da optcgapi.com (gratis, nessuna chiave).

    La risposta contiene TUTTE le stampe del codice (base/Parallel/Alt-Art...)
    coi loro market_price: le estraggo tutte ('prints') per lo spread di stampa
    — stessa chiamata di prima, zero costi in piu'."""
    if not code:
        return None
    try:
        data = _get_json(f"https://optcgapi.com/api/sets/card/{code}/")
    except Exception as exc:  # noqa: BLE001
        print(f"    optcgapi errore per {code}: {exc}")
        return None
    arr = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
    arr = [c for c in arr if c]
    if not arr:
        return None
    c = arr[0]
    prints = []
    for p in arr:
        try:
            v = float(str(p.get("market_price") or "").replace("$", ""))
        except ValueError:
            continue
        if v > 0 and p.get("card_name"):
            prints.append({"name": p["card_name"], "price": v})
    return {"image": c.get("card_image"), "serial": c.get("card_set_id"),
            "name": c.get("card_name"), "prints": prints}


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
    """Stima prezzo USD da eBay (annunci attivi). Mediana 'trimmed'.

    Ritorna (usd, n_annunci): n_annunci = quanti annunci attivi matchano la
    ricerca = proxy di LIQUIDITA' (gratis: e' nella stessa risposta).
    FIX robustezza: prima un errore di rete qui faceva crashare la pipeline
    (nessun try/except, a differenza di ebay_best_offer)."""
    import requests

    code_norm = _alnum(code) if code else None
    try:
        resp = requests.get(
            "https://api.ebay.com/buy/browse/v1/item_summary/search",
            headers={"Authorization": f"Bearer {token}", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"},
            params={"q": query, "category_ids": "183454", "limit": 100,
                    "filter": "buyingOptions:{FIXED_PRICE}"},
            timeout=30,
        )
        resp.raise_for_status()
        j = resp.json()
    except Exception as exc:  # noqa: BLE001
        print(f"    eBay prezzo errore: {exc}")
        return None, None
    total = j.get("total")
    items = j.get("itemSummaries", []) or []
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
        return None, total
    prices.sort()
    n = len(prices)
    core = prices[int(n * 0.2):int(n * 0.8)] if n >= 6 else prices
    return round(statistics.median(core or prices), 2), total


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
                "condition": it.get("condition"),
            }
    return best


# Per il PSA 10 vogliamo TENERE i gradati: dal filtro spazzatura tolgo psa/bgs/cgc/graded.
PSA10_JUNK = tuple(j for j in EBAY_JUNK if j.strip() not in ("psa", "bgs", "cgc", "graded"))


def ebay_psa10_eur(token: str, query: str):
    """Stima del valore PSA 10 in EUR dalla mediana (trimmed) degli annunci ATTIVI
    'PSA 10' su eBay US (piu' slab gradati), convertita in EUR. 1 chiamata.
    Ritorna {value, count} o None. Onesto: senza un campione minimo (>=5) non
    stimo, cosi' non mostro un numero fragile costruito su 1-2 annunci."""
    import requests

    try:
        resp = requests.get(
            "https://api.ebay.com/buy/browse/v1/item_summary/search",
            headers={"Authorization": f"Bearer {token}", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"},
            params={"q": f"{query} PSA 10", "limit": 50, "sort": "price",
                    "filter": "buyingOptions:{FIXED_PRICE}"},
            timeout=30,
        )
        resp.raise_for_status()
        items = resp.json().get("itemSummaries", []) or []
    except Exception as exc:  # noqa: BLE001
        print(f"    eBay PSA10 errore: {exc}")
        return None
    vals = []
    for it in items:
        title = (it.get("title") or "").lower()
        if "psa 10" not in title and "psa10" not in title:
            continue
        if any(j in (" " + title + " ") for j in PSA10_JUNK):
            continue
        price = it.get("price", {})
        if price.get("currency") != "USD":
            continue
        try:
            vals.append(float(price["value"]))
        except (KeyError, ValueError, TypeError):
            continue
    if len(vals) < 5:  # campione troppo piccolo: meglio nessun numero che uno fragile
        return None
    vals.sort()
    k = max(1, len(vals) // 5)          # scarta ~20% estremi (come il prezzo raw trimmed)
    trimmed = vals[k:-k] or vals
    return {"value": round(to_eur(statistics.median(trimmed)), 2), "count": len(vals)}


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
    # Feed MIRATI ai fattori che muovono i prezzi (piu' segnale)
    ("Tornei", 'Pokemon OR "One Piece" TCG tournament regional championship results', "US", "market", "en-US", "US", "US:en"),
    ("Uscite set", 'Pokemon OR "One Piece" TCG new set release preorder', "US", "news", "en-US", "US", "US:en"),
    ("Anime", '"One Piece" new arc OR Pokemon anime announcement trading card', "US", "news", "en-US", "US", "US:en"),
    ("Ristampe", 'Pokemon OR "One Piece" TCG reprint restock shortage', "US", "market", "en-US", "US", "US:en"),
]

PER_FEED = 8


def fetch_news():
    """Notizie reali via Google News RSS (aggrega tanti siti), con regione e tipo."""
    import email.utils
    import xml.etree.ElementTree as ET

    # Scarico tutti i feed IN PARALLELO (I/O bound), poi li leggo nell'ordine
    # di NEWS_FEEDS cosi' la dedup dei titoli resta deterministica.
    def _feed_root(feed):
        label, query, _, _, hl, gl, ceid = feed
        url = ("https://news.google.com/rss/search?q="
               + urllib.parse.quote(query) + f"&hl={hl}&gl={gl}&ceid={ceid}")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as resp:
                return ET.fromstring(resp.read().decode("utf-8", "ignore"))
        except Exception as exc:  # noqa: BLE001
            print(f"    news '{label}' errore: {exc}")
            return None

    with ThreadPoolExecutor(max_workers=8) as ex:
        roots = list(ex.map(_feed_root, NEWS_FEEDS))

    seen = set()
    news = []
    for (label, query, region, kind, hl, gl, ceid), root in zip(NEWS_FEEDS, roots):
        if root is None:
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
# Sentiment notizie + motore di segnale (COMPRA / TIENI / VENDI) trasparente
# ---------------------------------------------------------------------------
# Parole che indicano domanda/scarsità (rialzista) o offerta/rischio (ribassista).
BULL_WORDS = (
    "sold out", "sold-out", "shortage", "hard to find", "tournament", "championship",
    "regional", "worlds", "meta", "chase", "record", "grail", "hype", "surge", "spike",
    "rally", "anime", "exclusive", "limited", "psa 10", "gem mint", "demand", "restock sold",
    "esaurito", "impennata", "rincaro", "torneo", "campionato", "introvabile",
    "高騰", "優勝", "人気", "品切れ",  # 高騰 優勝 人気 品切れ
)
BEAR_WORDS = (
    "reprint", "reprinted", "oversupply", "restock", "crash", "plummet", "banned",
    "rotation", "counterfeit", "fake", "scam", "cooling off", "price drop", "overprinted",
    "ristampa", "crollo", "ribasso", "truffa", "falsi", "sovrapprezzo",
)

ICONIC_KEYS = (
    "pikachu", "charizard", "gengar", "mewtwo", "eevee", "umbreon", "espeon", "sylveon",
    "rayquaza", "lugia", "gardevoir", "lucario", "greninja", "snorlax", "gyarados",
    "luffy", "zoro", "nami", "sanji", "ace", "law", "shanks", "yamato", "robin",
    "doflamingo", "katakuri", "crocodile", "mihawk", "roger",
)


def news_dir(title: str):
    t = (title or "").lower()
    bull = sum(1 for w in BULL_WORDS if w in t)
    bear = sum(1 for w in BEAR_WORDS if w in t)
    if bull > bear:
        return "up"
    if bear > bull:
        return "down"
    return None


def is_iconic(name: str) -> bool:
    n = (name or "").lower()
    return any(k in n for k in ICONIC_KEYS)


def momentum_quality(tf, mom, in_bull, in_bear):
    """Qualita' di un momentum di prezzo: distingue un trend affidabile dal rumore.

    Usa SOLO dati reali che abbiamo: variazioni su 1/7/30 giorni (persistenza e
    anti-picco) + coerenza col sentiment delle notizie. NON usa volume/venduti
    perche' quel dato non ce l'abbiamo: niente numeri finti (linea di onesta').

    Ritorna (grade, note): grade in {"forte","debole",None}, note = spiegazione it.
    """
    if abs(mom) < 5:
        return None, None            # momentum irrilevante: non e' il driver
    tf = tf or {}
    d1, d30 = tf.get("d1"), tf.get("d30")
    up = mom > 0
    pro, contro = [], []

    # Persistenza sul lungo periodo (30g): il trend regge o e' un rimbalzo?
    if d30 is not None and abs(d30) >= 3:
        if (d30 > 0) == up:
            pro.append("confermato anche sui 30g")
        else:
            contro.append("controtendenza sui 30g (piu' un rimbalzo)")

    # Anti-picco: quasi tutto il movimento concentrato in 1 giorno = sospetto.
    if d1 is not None and abs(mom) >= 8 and (d1 > 0) == up and abs(d1) >= abs(mom) * 0.8:
        contro.append("salto concentrato in 1 giorno, cautela")

    # Coerenza con le notizie che citano la carta.
    if up and in_bull:
        pro.append("in linea con notizie positive")
    elif up and in_bear:
        contro.append("ma le notizie sono negative")
    elif (not up) and in_bear:
        pro.append("in linea con notizie negative")
    elif (not up) and in_bull:
        contro.append("ma le notizie sono positive")

    if pro and not contro:
        return "forte", pro[0]
    if contro:
        return "debole", contro[0]
    return None, None


def compute_reco(item, bull_titles, bear_titles):
    """Verdetto trasparente compra/tieni/vendi da segnali REALI (no previsione)."""
    key = card_key(item["name"])
    eu = (item.get("prices") or {}).get("eu")
    mom = item.get("change7d") or 0
    bo = item.get("bestOffer") or {}
    rng = item.get("range") or {}
    in_bull = any(key in t for t in bull_titles)
    in_bear = any(key in t for t in bear_titles)
    buy, sell, reasons = 0.0, 0.0, []

    # 1) In vendita sotto la media di mercato adesso (occasione d'acquisto)
    if bo.get("total") and eu and bo["total"] < eu * 0.75:
        buy += 2; reasons.append(f"\U0001F4B0 in vendita ora sotto la media (da ~€{bo['total']:.0f})")

    # 2) Posizione nello storico (vicino ai minimi = zona d'acquisto; ai massimi = valuta vendita)
    if rng.get("high") and rng.get("low") and rng["high"] > rng["low"] and eu is not None:
        pos = (eu - rng["low"]) / (rng["high"] - rng["low"])
        if pos <= 0.25:
            buy += 2; reasons.append("\U0001F4C9 vicino ai minimi dello storico")
        elif pos >= 0.85:
            sell += 2; reasons.append("\U0001F4C8 vicino ai massimi dello storico")

    # 3) Momentum, PESATO per la sua qualita'. Un rialzo "di qualita'"
    #    (persistente sui 30g, non un picco di 1 giorno, coerente con le notizie)
    #    conta di piu' verso COMPRA; uno "debole" conta meno, cosi' un finto pump
    #    non accende un COMPRA. La nota spiega il perche' in chiaro.
    mom_grade = None
    if mom >= 25:
        sell += 1
        _, note = momentum_quality(item.get("tf"), mom, in_bull, in_bear)
        r = "\U0001F680 forte rialzo recente (occhio: spesso conviene monetizzare)"
        reasons.append(f"{r} · {note}" if note else r)
    elif 5 <= mom < 25:
        mom_grade, note = momentum_quality(item.get("tf"), mom, in_bull, in_bear)
        buy += 1.5 if mom_grade == "forte" else 0.5 if mom_grade == "debole" else 1.0
        r = "\U0001F4C8 trend in salita"
        reasons.append(f"{r} · {note}" if note else r)
    elif mom <= -12 and is_iconic(item["name"]):
        buy += 1; reasons.append("\U0001FA78 forte calo su carta iconica (possibile occasione)")

    # 4) Notizie (rialziste/ribassiste che citano la carta)
    if in_bull:
        buy += 2; reasons.append("\U0001F4F0 notizie recenti positive")
    if in_bear:
        sell += 2; reasons.append("\U0001F4F0 notizie recenti negative")

    # 5) Personaggio iconico = domanda strutturale (piccolo peso a favore)
    if is_iconic(item["name"]):
        buy += 0.5

    if buy - sell >= 2.5:
        action = "compra"
    elif sell - buy >= 2.5:
        action = "vendi"
    else:
        action = "osserva"

    # Forza del segnale per la UI: quanto e' netto lo sbilanciamento buy/sell.
    # Declassata se il verdetto poggia su un rialzo di qualita' dubbia.
    margin = abs(buy - sell)
    if action == "osserva":
        quality = None
    elif margin >= 4:
        quality = "forte"
    elif margin >= 3:
        quality = "media"
    else:
        quality = "debole"
    if quality == "forte" and mom_grade == "debole":
        quality = "media"

    return {"action": action, "buy": round(buy, 1), "sell": round(sell, 1),
            "quality": quality, "reasons": reasons[:4]}


# ---------------------------------------------------------------------------
# Studio ARTISTI: quali illustratori hanno le carte di maggior valore.
# Campiona i rari (numeri alti) dei set Pokémon recenti, prende illustratore +
# prezzo Cardmarket, aggrega per artista. Dati reali; cresce nel tempo (cache).
# ---------------------------------------------------------------------------
def build_artists(max_fetch: int = 70, budget_s: float = 70.0):
    # Budget di tempo: se le API sono lente in CI, mi fermo e restituisco quel che ho
    # (con la cache non si perde nulla). Cosi' NON blocco mai il deploy.
    deadline = time.monotonic() + budget_s
    try:
        sets = _get_json("https://api.tcgdex.net/v2/en/sets", timeout=10)
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

    # Fetch IN PARALLELO (prima i set, poi le carte candidate): stesso budget,
    # ma il campionamento finisce in pochi secondi invece che ~1 minuto.
    def _set_full(s):
        if time.monotonic() > deadline:
            return None
        try:
            return _get_json(f"https://api.tcgdex.net/v2/en/sets/{s['id']}", timeout=8)
        except Exception:  # noqa: BLE001
            return None

    with ThreadPoolExecutor(max_workers=8) as ex:
        fulls = list(ex.map(_set_full, reversed(recent)))

    cand_ids = []
    for full in fulls:
        if not full:
            continue
        for c in sorted(full.get("cards") or [], key=num_of, reverse=True)[:10]:
            cand_ids.append(c["id"])
    cand_ids = cand_ids[:max_fetch]

    def _card_full(cid):
        if time.monotonic() > deadline:
            return None
        try:
            return _get_json(f"https://api.tcgdex.net/v2/en/cards/{cid}", timeout=8)
        except Exception:  # noqa: BLE001
            return None

    with ThreadPoolExecutor(max_workers=8) as ex:
        cards_full = list(ex.map(_card_full, cand_ids))

    by_art = {}
    fetched = 0
    for fc in cards_full:
        if not fc:
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


def update_artist_trend(artists):
    """Trend nel tempo del valore medio per artista (dato REALE che si accumula).

    Un punto al giorno (media del giorno) in artists_hist.json, conservato tra i
    run via cache Actions come history.json. Aggiunge a ogni artista trendPct
    (variazione dal primo punto disponibile), trendDays e una mini-serie 'spark'.
    All'inizio trendPct=None finche' non si hanno >=2 giorni: onesto, cresce coi dati.
    """
    ART_HIST_LEN = 120  # ~4 mesi di punti giornalieri
    hist = {}
    if ARTISTS_HIST.exists():
        try:
            hist = json.loads(ARTISTS_HIST.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            hist = {}
    today = NOW.date().isoformat()
    for a in artists:
        key = a["name"].strip().lower()
        series = hist.get(key, [])
        if series and series[-1][0] == today:   # un solo punto al giorno
            series[-1] = [today, a["avg"]]
        else:
            series.append([today, a["avg"]])
        series = series[-ART_HIST_LEN:]
        hist[key] = series
        base = series[0][1] if series else None
        if len(series) >= 2 and base:
            a["trendPct"] = round((series[-1][1] - base) / base * 100, 1)
        else:
            a["trendPct"] = None
        a["trendDays"] = len(series)
        a["spark"] = [round(v, 2) for _, v in series[-12:]]
    ARTISTS_HIST.write_text(json.dumps(hist, ensure_ascii=False, indent=2), encoding="utf-8")
    return artists


def build_calendar(max_sets: int = 12):
    """Calendario CATALIZZATORI: uscite set Pokemon con releaseDate REALE da
    TCGdex (in arrivo e appena usciti — muovono i prezzi: hype prima, offerta
    alta dopo). One Piece: le fonti gratuite non danno date -> escluso, onesto.
    ~12 fetch paralleli, budget implicito nei timeout."""
    try:
        sets = _get_json("https://api.tcgdex.net/v2/en/sets", timeout=10)
    except Exception as exc:  # noqa: BLE001
        print(f"    calendario: errore lista set: {exc}")
        return []
    if not isinstance(sets, list):
        return []

    def _full(s):
        try:
            return _get_json(f"https://api.tcgdex.net/v2/en/sets/{s['id']}", timeout=8)
        except Exception:  # noqa: BLE001
            return None

    with ThreadPoolExecutor(max_workers=8) as ex:
        fulls = list(ex.map(_full, sets[-max_sets:]))

    out = []
    for f in fulls:
        if not f or not f.get("releaseDate"):
            continue
        out.append({
            "game": "pokemon", "id": f.get("id"), "name": f.get("name"),
            "date": f["releaseDate"],
            "logo": (f.get("logo") + ".png") if f.get("logo") else None,
            "count": (f.get("cardCount") or {}).get("official"),
        })
    out.sort(key=lambda x: x["date"], reverse=True)
    print(f"[TCG Radar] Calendario: {len(out)} set con data reale")
    return out[:10]


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

    # Sentiment: ogni notizia diventa rialzista/ribassista/neutra
    for n in news:
        n["dir"] = news_dir(n.get("title", ""))
    bull_titles = [n["title"].lower() for n in news if n.get("dir") == "up" and n.get("title")]
    bear_titles = [n["title"].lower() for n in news if n.get("dir") == "down" and n.get("title")]

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

    # --- PREFETCH PARALLELO: tutte le chiamate di rete per carta partono insieme
    # (TCGdex / eBay / optcgapi sono I/O bound). Il loop sotto resta sequenziale
    # ma legge dai risultati gia' pronti: stesso output, run molto piu' corto =
    # dati piu' freschi a ogni ciclo. Le funzioni di fetch gestiscono gia' gli
    # errori internamente (ritornano None), quindi il prefetch non puo' bloccare.
    t0 = time.monotonic()
    pk_pre, op_usd_pre, op_liq_pre, op_best_pre, op_meta_pre = {}, {}, {}, {}, {}

    def _prefetch(card):
        ref = card["ref"]
        game = card.get("game")
        if game == "pokemon" and card.get("pokemontcg_id") and not FORCE_DEMO:
            pk_pre[ref] = tcgdex_fetch(card["pokemontcg_id"])
        elif game == "onepiece":
            if token is not None:
                q = card.get("ebay_query", card["name"])
                code = card.get("ebay_code")
                op_usd_pre[ref], op_liq_pre[ref] = ebay_price_usd(token, q, code)
                op_best_pre[ref] = ebay_best_offer(token, q, code)
            op_meta_pre[ref] = optcg_fetch(card.get("ebay_code"))

    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(_prefetch, cards))
    print(f"[TCG Radar] Prefetch di {len(cards)} carte in {time.monotonic()-t0:.1f}s")

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
        listings = None    # n. annunci attivi eBay (proxy liquidita', solo One Piece)
        illustrator = None

        # --- Pokemon: TCGdex (Cardmarket EUR), gia' prefetchato ---
        if game == "pokemon" and card.get("pokemontcg_id") and not FORCE_DEMO:
            info = pk_pre.get(ref)
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

        # --- One Piece: eBay USA -> EUR, gia' prefetchato ---
        elif game == "onepiece" and token is not None:
            usd = op_usd_pre.get(ref)
            if usd is not None:
                eur = to_eur(usd)
                source = "eBay->EUR"
            best_offer = op_best_pre.get(ref)
            listings = op_liq_pre.get(ref)  # liquidita': quanti annunci attivi

        # immagine + seriale One Piece da optcgapi (gia' prefetchato)
        spread = None
        if game == "onepiece":
            oc = op_meta_pre.get(ref)
            if oc:
                image = oc["image"] or image
                serial = oc["serial"] or serial
                # Spread di stampa: base (la piu' economica) vs stampa premium
                # (la piu' cara) dello STESSO codice. Il rapporto nel tempo dice
                # se il premium si sta comprimendo (relativamente conveniente).
                # Guardia: optcgapi a volte infila nel codice una carta di un
                # ALTRO personaggio (visto: "Buggy (Manga)" dentro OP05-067 di
                # Zoro) -> tengo solo le stampe che condividono il personaggio.
                priced = sorted(oc.get("prints") or [], key=lambda p: p["price"])
                if len(priced) >= 2 and priced[0]["price"] > 0:
                    key = card_key(priced[0]["name"])
                    priced = [p for p in priced if key in p["name"].lower()]
                if len(priced) >= 2 and priced[0]["price"] > 0:
                    ratio = priced[-1]["price"] / priced[0]["price"]
                    if ratio >= 1.5:  # sotto x1.5 non e' un vero spread
                        spread = {
                            "base": to_eur(priced[0]["price"]),
                            "premium": to_eur(priced[-1]["price"]),
                            "premiumName": priced[-1]["name"],
                            "ratio": round(ratio, 1),
                        }

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
            "listings": listings,
            "spread": spread,
            "illustrator": illustrator,
            "range": rng,
        })
        print(f"  - {ref:24} {('EUR '+format(eur,'.2f')) if eur is not None else '--':>12} ({source:11}) {ch:+.1f}% 7g")

    market_pulse = round(statistics.mean(changes), 1) if changes else 0.0

    # Polso del mercato NEL TEMPO: accumulo un punto per run (cache Actions,
    # come history.json) -> in Home si vede se il mercato carte sale o scende.
    pulse_hist = []
    if PULSE_HIST.exists():
        try:
            pulse_hist = json.loads(PULSE_HIST.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pulse_hist = []
    pulse_hist.append([NOW.isoformat(), market_pulse])
    pulse_hist = pulse_hist[-1000:]  # ~20 giorni a 30 min
    PULSE_HIST.write_text(json.dumps(pulse_hist, ensure_ascii=False), encoding="utf-8")

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
        item["reco"] = compute_reco(item, bull_titles, bear_titles)
        radar.append((mom + (15 if in_news else 0), item["ref"]))
    radar.sort(reverse=True)
    radar_refs = [r for _, r in radar[:12]]

    # "Da comprare ora": carte col verdetto COMPRA, ordinate per forza del segnale
    buy_now = sorted(
        (it for it in items if it["reco"]["action"] == "compra"),
        key=lambda it: it["reco"]["buy"], reverse=True,
    )
    buy_now_refs = [it["ref"] for it in buy_now[:8]]
    n_buy = sum(1 for it in items if it["reco"]["action"] == "compra")
    n_sell = sum(1 for it in items if it["reco"]["action"] == "vendi")
    print(f"[TCG Radar] Segnali: {n_buy} COMPRA, {n_sell} VENDI su {len(items)} carte")

    # "Backtest" leggero: da quando dura il segnale attuale e come è andato il prezzo da allora.
    signals = {}
    if SIGNALS.exists():
        try:
            signals = json.loads(SIGNALS.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            signals = {}
    today = NOW.date().isoformat()
    for it in items:
        ref = it["ref"]
        act = it["reco"]["action"]
        eu = (it.get("prices") or {}).get("eu")
        prev = signals.get(ref)
        if not prev or prev.get("action") != act:
            signals[ref] = {"action": act, "since": today, "price": eu}
        s = signals[ref]
        chg = None
        if s.get("price") and eu:
            chg = round((eu - s["price"]) / s["price"] * 100, 1)
        it["recoSince"] = {"action": s["action"], "since": s["since"], "price": s.get("price"), "changePct": chg}
    SIGNALS.write_text(json.dumps(signals, ensure_ascii=False, indent=2), encoding="utf-8")

    # Track record REALE del motore: come stanno andando i segnali attivi da
    # quando si sono accesi (media dei changePct accumulati — dati, non promesse).
    buy_ch = [it["recoSince"]["changePct"] for it in items
              if it["reco"]["action"] == "compra" and it["recoSince"].get("changePct") is not None]
    sell_ch = [it["recoSince"]["changePct"] for it in items
               if it["reco"]["action"] == "vendi" and it["recoSince"].get("changePct") is not None]
    signal_stats = {
        "buyN": len(buy_ch), "buyAvg": round(statistics.mean(buy_ch), 1) if buy_ch else None,
        "sellN": len(sell_ch), "sellAvg": round(statistics.mean(sell_ch), 1) if sell_ch else None,
    }

    # Storico OCCASIONI: in quali giorni una carta e' stata vista sotto mercato
    # (-20%+). Cosi' distinguo "va spesso in svendita, puoi aspettare" da
    # "occasione rara, muoviti". Un giorno conta una volta sola.
    deals_hist = {}
    if DEALS_HIST.exists():
        try:
            deals_hist = json.loads(DEALS_HIST.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            deals_hist = {}
    for it in items:
        bo = it.get("bestOffer") or {}
        eu = (it.get("prices") or {}).get("eu")
        if bo.get("total") and eu and bo["total"] <= eu * 0.8:
            dates = deals_hist.setdefault(it["ref"], [])
            if today not in dates:
                dates.append(today)
            deals_hist[it["ref"]] = dates[-45:]  # finestra ~45 giorni
        if it["ref"] in deals_hist and deals_hist[it["ref"]]:
            it["dealDays"] = len(deals_hist[it["ref"]])
    DEALS_HIST.write_text(json.dumps(deals_hist, ensure_ascii=False, indent=2), encoding="utf-8")

    # Spread di stampa NEL TEMPO: un punto al giorno del rapporto base<->premium.
    # Compresso rispetto all'inizio = la stampa premium e' relativamente a sconto.
    spreads_hist = {}
    if SPREADS_HIST.exists():
        try:
            spreads_hist = json.loads(SPREADS_HIST.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            spreads_hist = {}
    for it in items:
        sp = it.get("spread")
        if not sp:
            continue
        series_sp = spreads_hist.get(it["ref"], [])
        if series_sp and series_sp[-1][0] == today:
            series_sp[-1] = [today, sp["ratio"]]
        else:
            series_sp.append([today, sp["ratio"]])
        spreads_hist[it["ref"]] = series_sp[-60:]
        base0 = series_sp[0][1] if series_sp else None
        if len(series_sp) >= 2 and base0:
            sp["trendPct"] = round((sp["ratio"] - base0) / base0 * 100, 1)
        else:
            sp["trendPct"] = None
        sp["days"] = len(series_sp)
    SPREADS_HIST.write_text(json.dumps(spreads_hist, ensure_ascii=False, indent=2), encoding="utf-8")

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
        artists = update_artist_trend(artists)  # trend del valore medio nel tempo

    calendar = build_calendar() if not FORCE_DEMO else []

    # Stima PSA 10 (EUR) per le carte piu' di valore: 1 chiamata eBay ciascuna,
    # con budget di tempo + cache, NON bloccante. Se manca il token o l'API e'
    # lenta, si riusa la cache / si salta e restano i link ai prezzi graded reali.
    psa10_cache = {}
    if PSA10.exists():
        try:
            psa10_cache = json.loads(PSA10.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            psa10_cache = {}
    if token is not None:
        # Candidati: prima gli ICONICI, poi per valore (il mercato PSA 10 e' piu'
        # liquido su questi → piu' probabile avere un campione sano di annunci).
        cand = [it for it in items if (it.get("prices") or {}).get("eu")]
        cand.sort(key=lambda it: (is_iconic(it["name"]), it["prices"]["eu"]), reverse=True)
        cand = cand[:16]

        # Quota eBay intelligente: le stime PSA 10 non cambiano ogni 30 minuti →
        # ricalcolo SOLO quelle piu' vecchie di 6 ore. Risparmio ~700 call/giorno.
        def _stale(ref):
            e = psa10_cache.get(ref)
            if not e or not e.get("ts"):
                return True
            try:
                age = (NOW - datetime.datetime.fromisoformat(e["ts"])).total_seconds()
            except ValueError:
                return True
            return age > 6 * 3600

        todo = [it for it in cand if _stale(it["ref"])]
        deadline = time.monotonic() + 60.0

        def _est(it):
            if time.monotonic() > deadline:
                return it["ref"], None
            # Query pulita: via i qualificatori tra parentesi e la parte "/totale"
            # del numero (es. "107/111"→"107"; il codice One Piece "OP05-119" resta).
            nm = it["name"].split("(")[0].strip()
            num = str(it.get("serial") or "").split("/")[0].strip()
            return it["ref"], ebay_psa10_eur(token, (nm + " " + num).strip())

        done = 0
        with ThreadPoolExecutor(max_workers=4) as ex:
            for ref, est in ex.map(_est, todo):
                if est:
                    est["ts"] = NOW.isoformat()
                    psa10_cache[ref] = est
                    done += 1
        PSA10.write_text(json.dumps(psa10_cache, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[TCG Radar] PSA 10: {done} stime aggiornate ({len(todo)} scadute su {len(cand)} candidati)")
    for it in items:
        if it["ref"] in psa10_cache:
            it["psa10"] = psa10_cache[it["ref"]]

    data = {
        "lastUpdate": NOW.isoformat(),
        "marketPulse": market_pulse,
        "fxUsdEur": USD_EUR,
        "radar": radar_refs,
        "buyNow": buy_now_refs,
        "signalStats": signal_stats,
        "pulseHist": downsample(pulse_hist, 90),
        "calendar": calendar,
        "items": items,
        "news": news,
        "artists": artists,
    }

    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    HISTORY.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[TCG Radar] Scritto {OUTPUT.name} (pulse {market_pulse:+.1f}%) e {HISTORY.name}")


if __name__ == "__main__":
    main()
