import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, StatusBar, ScrollView, ActivityIndicator,
  Image, Linking, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Sparkline from './Sparkline';
import Chart from './Chart';
import { theme, font } from './theme';
import sampleData from './sample.json';

const DATA_URL = 'https://chrx93.github.io/data.json'; // dati live pubblicati
const USD_EUR = 0.92; // cambio indicativo per stime in-app (le carte del motore sono gia' in EUR)

const TAB_META = [
  { label: 'Home', icon: 'home', iconOutline: 'home-outline' },
  { label: 'Watchlist', icon: 'star', iconOutline: 'star-outline' },
  { label: 'Notizie', icon: 'newspaper', iconOutline: 'newspaper-outline' },
  { label: 'Cerca', icon: 'search', iconOutline: 'search-outline' },
];

// Tutto in EURO.
const fmt = (n) => {
  if (n == null) return '—';
  const v = Number(n);
  return v >= 100 ? `€${Math.round(v)}` : `€${v.toFixed(2)}`;
};

// Valore in EUR: usa eu se c'e', altrimenti converte us con un cambio indicativo.
const toEur = (prices) => {
  if (!prices) return null;
  if (prices.eu != null) return prices.eu;
  if (prices.us != null) return Math.round(prices.us * USD_EUR * 100) / 100;
  return null;
};

const pct = (n) => {
  if (n == null) return '—';
  if (n === 0) return '0%';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
};

const changeColor = (n) => {
  if (!n || n === 0) return theme.neutral;
  return n > 0 ? theme.up : theme.down;
};

const buyLinksFor = (item) => {
  if (item.buyLinks) return item.buyLinks;
  const nm = item.name || '';
  const serial = item.serial || '';
  const cm = item.game === 'onepiece'
    ? 'https://www.cardmarket.com/en/OnePiece/Products/Search?searchString=' + encodeURIComponent(nm)
    : 'https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=' + encodeURIComponent(nm);
  const ebay = item.buyUrl || ('https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(`${nm} ${serial}`));
  const vinted = 'https://www.vinted.it/catalog?search_text=' + encodeURIComponent(`${nm} ${serial}`);
  return { cardmarket: cm, ebay, vinted };
};

// Converte una carta TCGdex (completa) nel formato "item" dell'app
function mapTcgdexCard(c) {
  let usd = null;
  const tp = (c.pricing && c.pricing.tcgplayer) || null;
  if (tp) {
    for (const k of ['holofoil', 'normal', 'reverse-holofoil', '1st-edition-holofoil']) {
      if (tp[k] && tp[k].marketPrice != null) { usd = tp[k].marketPrice; break; }
    }
    if (usd == null) {
      for (const k of Object.keys(tp)) {
        if (tp[k] && typeof tp[k] === 'object' && tp[k].marketPrice != null) { usd = tp[k].marketPrice; break; }
      }
    }
  }
  const cm = (c.pricing && c.pricing.cardmarket) || null;
  let eur = (cm && cm.trend != null) ? cm.trend : null;
  if (usd && eur && (eur > usd * 5 || usd > eur * 5)) eur = null;
  let tf = null;
  let history = [];
  if (cm && eur != null && eur >= 2) {
    const chg = (avg) => {
      if (!avg) return null;
      const v = Math.round(((eur - avg) / avg) * 1000) / 10;
      return Math.abs(v) <= 60 ? v : null;
    };
    tf = { d1: chg(cm.avg1), d7: chg(cm.avg7), d30: chg(cm.avg30) };
    history = [cm.avg30, cm.avg7, eur].filter(x => x != null);
  }
  const setObj = c.set || {};
  const total = (setObj.cardCount && setObj.cardCount.official) || '';
  const serial = total ? `${c.localId}/${total}` : String(c.localId || '');
  const image = c.image ? c.image + '/high.png' : null;
  return {
    ref: c.id,
    name: c.name,
    game: 'pokemon',
    set: setObj.name || '',
    rarity: c.rarity || '—',
    serial,
    image,
    change7d: (tf && tf.d7 != null) ? tf.d7 : 0,
    tf,
    prices: { eu: eur, us: usd },
    history,
    note: `${setObj.name || ''}${c.rarity ? ' · ' + c.rarity : ''}`,
    signal: 'FATTO',
  };
}

// Converte una carta One Piece (optcgapi.com) nel formato "item" dell'app
function mapOptcgCard(c) {
  const num = parseFloat(String(c.market_price || '').replace(/[^0-9.]/g, ''));
  const usd = isNaN(num) ? null : num;
  return {
    ref: c.card_set_id,
    name: c.card_name,
    game: 'onepiece',
    set: c.set_name || '',
    rarity: c.rarity || '—',
    serial: c.card_set_id,
    image: c.card_image || null,
    change7d: 0,
    tf: null,
    prices: { eu: usd != null ? Math.round(usd * USD_EUR * 100) / 100 : null, us: usd },
    history: [],
    note: `${c.set_name || ''}${c.rarity ? ' · ' + c.rarity : ''}`,
    signal: 'FATTO',
  };
}

function SignalBadge({ signal }) {
  const isFatto = signal === 'FATTO';
  return (
    <View style={[styles.badge, { backgroundColor: isFatto ? theme.fatto : theme.hype }]}>
      <Text style={[styles.badgeText, { color: isFatto ? theme.fattoText : theme.hypeText }]}>
        {signal}
      </Text>
    </View>
  );
}

function AlertBadge() {
  return (
    <View style={styles.alertBadge}>
      <Text style={styles.alertText}>🔔 ALERT</Text>
    </View>
  );
}

function CardRow({ item, onPress, showAlert }) {
  const isAlert = Math.abs(item.change7d) >= 10;
  const priceVal = toEur(item.prices);
  return (
    <TouchableOpacity style={styles.row} onPress={() => onPress(item)} activeOpacity={0.75}>
      {item.image ? (
        <Image source={{ uri: item.image }} style={styles.thumb} resizeMode="contain" />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]}>
          <Ionicons name="image-outline" size={20} color={theme.textDim} />
        </View>
      )}
      <View style={styles.rowLeft}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
          {isAlert && showAlert && <AlertBadge />}
        </View>
        <Text style={styles.rowSub} numberOfLines={1}>{item.set}{item.serial ? ` · ${item.serial}` : ` · ${item.rarity}`}</Text>
        <Text style={[styles.rowChange, { color: changeColor(item.change7d) }]}>
          {pct(item.change7d)} <Text style={styles.rowSub}>7g</Text>
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Sparkline
          data={item.history}
          color={item.change7d >= 0 ? theme.up : theme.down}
          width={72}
          height={30}
        />
        <Text style={styles.rowPrice}>{fmt(priceVal)}</Text>
      </View>
    </TouchableOpacity>
  );
}

function BuyButtons({ item }) {
  const links = buyLinksFor(item);
  const opts = [
    { key: 'cardmarket', label: 'Cardmarket', icon: 'pricetag-outline', primary: true },
    { key: 'ebay', label: 'eBay', icon: 'cart-outline' },
    { key: 'vinted', label: 'Vinted', icon: 'shirt-outline' },
  ].filter(o => links[o.key]);
  return (
    <View style={styles.buyRow}>
      {opts.map(o => (
        <TouchableOpacity
          key={o.key}
          style={[styles.buy3, o.primary && styles.buy3Primary]}
          onPress={() => Linking.openURL(links[o.key])}
          activeOpacity={0.85}
        >
          <Ionicons name={o.icon} size={16} color={o.primary ? theme.bg : theme.accent} />
          <Text style={[styles.buy3Text, { color: o.primary ? theme.bg : theme.accent }]}>{o.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function DetailScreen({ item, onBack, isSaved, onToggleSave }) {
  const priceVal = toEur(item.prices);
  return (
    <ScrollView style={styles.detail} contentContainerStyle={{ paddingBottom: 40 }}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack}>
        <Ionicons name="arrow-back" size={20} color={theme.accent} />
        <Text style={styles.backText}>Indietro</Text>
      </TouchableOpacity>

      <Text style={styles.detailName}>{item.name}</Text>
      <Text style={styles.detailSub}>{item.set} · {item.rarity}{item.serial ? ` · ${item.serial}` : ''}</Text>

      {item.image && (
        <Image source={{ uri: item.image }} style={styles.detailImage} resizeMode="contain" />
      )}

      <Text style={styles.sectionTitle}>Andamento prezzo</Text>
      <Chart series={item.chart || item.history} />

      {item.tf && (
        <>
          <View style={styles.tfRow}>
            {[['1G', 'd1'], ['7G', 'd7'], ['30G', 'd30']].map(([label, key]) => (
              <View key={key} style={styles.tfChip}>
                <Text style={styles.tfLabel}>{label}</Text>
                <Text style={[styles.tfVal, { color: changeColor(item.tf[key]) }]}>{pct(item.tf[key])}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.tfNote}>variazioni in EUR</Text>
        </>
      )}

      <Text style={styles.sectionTitle}>Valore di mercato</Text>
      <View style={styles.priceBig}>
        <Text style={styles.priceBigVal}>{fmt(priceVal)}</Text>
        <Text style={styles.priceBigNote}>
          {item.game === 'onepiece' ? 'prezzo indicativo da annunci (eBay), convertito in €' : 'prezzo di tendenza Cardmarket (€)'}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Segnale</Text>
      <View style={styles.signalRow}>
        <SignalBadge signal={item.signal} />
        <Text style={styles.noteText}>{item.note}</Text>
      </View>

      <TouchableOpacity style={styles.saveBtn} onPress={() => onToggleSave(item)} activeOpacity={0.8}>
        <Ionicons name={isSaved ? 'checkmark-circle' : 'add-circle-outline'} size={18} color={theme.accent} />
        <Text style={styles.saveText}>{isSaved ? 'Nella watchlist — tocca per rimuovere' : 'Aggiungi alla watchlist'}</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Compra / confronta</Text>
      <BuyButtons item={item} />
    </ScrollView>
  );
}

function RadarSection({ cards, onPress }) {
  if (!cards || !cards.length) return null;
  return (
    <View style={styles.radarBox}>
      <View style={styles.radarHeader}>
        <Ionicons name="speedometer-outline" size={16} color={theme.accent} />
        <Text style={styles.radarTitle}>RADAR · opportunità</Text>
      </View>
      {cards.map(item => {
        const pv = toEur(item.prices);
        return (
          <TouchableOpacity key={item.ref} style={styles.radarRow} onPress={() => onPress(item)} activeOpacity={0.7}>
            {item.image ? (
              <Image source={{ uri: item.image }} style={styles.radarThumb} resizeMode="contain" />
            ) : (
              <View style={[styles.radarThumb, styles.thumbEmpty]} />
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.radarName} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.radarReason} numberOfLines={1}>{item.radarReason}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text style={styles.radarPrice}>{fmt(pv)}</Text>
              <Ionicons name={item.inNews ? 'newspaper-outline' : 'trending-up'} size={14} color={item.inNews ? theme.accent : theme.up} />
            </View>
          </TouchableOpacity>
        );
      })}
      <Text style={styles.radarNote}>Segnale automatico (momentum + notizie), non una previsione. Ruota a ogni aggiornamento.</Text>
    </View>
  );
}

function HomeTab({ data, rotation, onPress, refreshing, onRefresh }) {
  const items = data.items || [];
  const byRef = {};
  items.forEach(i => { byRef[i.ref] = i; });
  const pool = (data.radar || []).map(r => byRef[r]).filter(Boolean);
  const k = pool.length ? rotation % pool.length : 0;
  const radarCards = pool.length ? pool.slice(k).concat(pool.slice(0, k)).slice(0, 6) : [];
  const movers = [...items].sort((a, b) => Math.abs(b.change7d) - Math.abs(a.change7d));
  return (
    <FlatList
      data={movers}
      keyExtractor={i => i.ref}
      ListHeaderComponent={
        <>
          <RadarSection cards={radarCards} onPress={onPress} />
          <Text style={styles.listLabel}>Tutte le carte · variazione 7g</Text>
        </>
      }
      renderItem={({ item }) => <CardRow item={item} onPress={onPress} showAlert />}
      contentContainerStyle={{ paddingBottom: 20 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
    />
  );
}

function WatchlistTab({ data, onPress, refreshing, onRefresh }) {
  if (!data || data.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={styles.emptyBox}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
      >
        <Ionicons name="star-outline" size={40} color={theme.textDim} />
        <Text style={styles.searchHint}>
          La tua watchlist è vuota. Vai su “Cerca”, apri una carta e tocca “Aggiungi alla watchlist”.
        </Text>
      </ScrollView>
    );
  }
  return (
    <FlatList
      data={data}
      keyExtractor={i => i.ref}
      renderItem={({ item }) => <CardRow item={item} onPress={onPress} showAlert={false} />}
      contentContainerStyle={{ paddingBottom: 20 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
    />
  );
}

const REGION = { US: { flag: '🇺🇸', label: 'USA' }, EU: { flag: '🇪🇺', label: 'Europa' }, JP: { flag: '🇯🇵', label: 'Giappone' } };
const KIND = { video: '🎥', forum: '💬', market: '📈', news: '📰' };

const NEWS_FILTERS = [
  { key: 'all', label: 'Tutte', test: () => true },
  { key: 'US', label: '🇺🇸 USA', test: n => n.region === 'US' },
  { key: 'EU', label: '🇪🇺 Europa', test: n => n.region === 'EU' },
  { key: 'JP', label: '🇯🇵 Giappone', test: n => n.region === 'JP' },
  { key: 'video', label: '🎥 Video', test: n => n.kind === 'video' },
  { key: 'market', label: '📈 Mercato', test: n => n.kind === 'market' },
  { key: 'forum', label: '💬 Community', test: n => n.kind === 'forum' },
];

function NewsTab({ news, lastUpdate, refreshing, onRefresh }) {
  const [active, setActive] = useState('all');
  const all = news || [];
  const chips = NEWS_FILTERS.filter(f => f.key === 'all' || all.some(f.test));
  const filtered = all.filter((NEWS_FILTERS.find(f => f.key === active) || NEWS_FILTERS[0]).test);

  return (
    <FlatList
      data={filtered}
      keyExtractor={i => i.id}
      ListHeaderComponent={
        <View>
          <Text style={styles.newsUpdated}>
            {all.length} notizie · agg. {lastUpdate ? new Date(lastUpdate).toLocaleString('it-IT') : '—'} · tira giù per aggiornare
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {chips.map(f => {
              const on = f.key === active;
              return (
                <TouchableOpacity key={f.key} style={[styles.chip, on && styles.chipOn]} onPress={() => setActive(f.key)} activeOpacity={0.7}>
                  <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{f.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      }
      renderItem={({ item }) => {
        const reg = REGION[item.region];
        return (
          <TouchableOpacity
            style={styles.newsCard}
            activeOpacity={item.url ? 0.7 : 1}
            onPress={() => item.url && Linking.openURL(item.url)}
          >
            <View style={styles.newsHeader}>
              <Text style={styles.newsTag}>{(reg ? reg.flag + ' ' : '')}{KIND[item.kind] || ''}</Text>
              <Text style={styles.newsSource} numberOfLines={1}>{item.source}</Text>
              <Text style={styles.newsDate}>{item.date}{item.time ? ' · ' + item.time : ''}</Text>
            </View>
            <Text style={styles.newsTitle}>{item.title}</Text>
            {item.url ? (
              <View style={styles.newsDir}>
                <Ionicons name="open-outline" size={14} color={theme.textDim} />
                <Text style={[styles.newsDirText, { color: theme.textDim }]}>Tocca per leggere</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        );
      }}
      ListEmptyComponent={<Text style={styles.searchHint}>Nessuna notizia in questa categoria.</Text>}
      contentContainerStyle={{ paddingBottom: 20 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
    />
  );
}

function SearchTab({ onPress }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setSearched(false); setError(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSearched(true);
    const handle = setTimeout(async () => {
      const stop = ['di', 'the', 'one', 'piece', 'card', '&'];
      const isNum = /^[0-9]+$/.test(term);
      const opCode = (term.toUpperCase().match(/(OP|ST|EB|P)\d{2}-\d{3}/) || [])[0];
      const words = term.toLowerCase().split(/\s+/).filter(w => w.length >= 2 && !stop.includes(w));
      const longest = words.reduce((a, b) => (b.length > a.length ? b : a), '');
      const tasks = [];

      if (isNum) {
        tasks.push(fetch('https://api.tcgdex.net/v2/en/cards?localId=' + term)
          .then(r => r.json())
          .then(a => (Array.isArray(a) ? a : []).slice(0, 20).map(c => ({
            key: 'pk' + c.id, src: 'pkm', id: c.id, name: c.name,
            sub: 'Pokémon · #' + (c.localId || ''),
            thumb: c.image ? c.image + '/low.png' : null,
          }))).catch(() => []));
      } else if (longest) {
        tasks.push(fetch('https://api.tcgdex.net/v2/en/cards?name=' + encodeURIComponent(longest))
          .then(r => r.json())
          .then(a => (Array.isArray(a) ? a : [])
            .filter(c => c && c.name && words.every(w => c.name.toLowerCase().includes(w)))
            .slice(0, 20).map(c => ({
              key: 'pk' + c.id, src: 'pkm', id: c.id, name: c.name,
              sub: 'Pokémon · #' + (c.localId || ''),
              thumb: c.image ? c.image + '/low.png' : null,
            }))).catch(() => []));
      }

      if (opCode) {
        tasks.push(fetch('https://optcgapi.com/api/sets/card/' + opCode + '/')
          .then(r => r.json())
          .then(d => (Array.isArray(d) ? d : [d]).filter(Boolean).map((c, i) => ({
            key: 'op' + c.card_set_id + i, src: 'op', raw: c, name: c.card_name,
            sub: 'One Piece · ' + c.card_set_id, thumb: c.card_image || null,
          }))).catch(() => []));
      } else if (longest) {
        tasks.push(fetch('https://optcgapi.com/api/sets/filtered/?card_name=' + encodeURIComponent(longest))
          .then(r => r.json())
          .then(a => (Array.isArray(a) ? a : [])
            .filter(c => c && c.card_name && words.every(w => c.card_name.toLowerCase().includes(w)))
            .slice(0, 20).map((c, i) => ({
              key: 'op' + c.card_set_id + i, src: 'op', raw: c, name: c.card_name,
              sub: 'One Piece · ' + c.card_set_id, thumb: c.card_image || null,
            }))).catch(() => []));
      }

      try {
        const lists = await Promise.all(tasks);
        if (!cancelled) setResults(lists.flat().slice(0, 30));
      } catch (e) {
        if (!cancelled) { setError('Errore di rete, riprova.'); setResults([]); }
      }
      if (!cancelled) setLoading(false);
    }, 280);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [q]);

  const openCard = async (s) => {
    setOpening(true);
    try {
      if (s.src === 'op') {
        onPress(mapOptcgCard(s.raw));
      } else {
        const res = await fetch('https://api.tcgdex.net/v2/en/cards/' + s.id);
        const full = await res.json();
        onPress(mapTcgdexCard(full));
      }
    } catch (e) {
      setError('Non riesco ad aprire la carta, riprova.');
    }
    setOpening(false);
  };

  return (
    <ScrollView style={{ paddingHorizontal: 12, paddingTop: 12 }} keyboardShouldPersistTaps="handled">
      <View style={styles.searchBar}>
        <Ionicons name="search" size={16} color={theme.textDim} />
        <TextInput
          style={styles.searchInput}
          placeholder="Cerca Pokémon o One Piece..."
          placeholderTextColor={theme.textDim}
          value={q}
          onChangeText={setQ}
          autoCorrect={false}
        />
        {(loading || opening) ? <ActivityIndicator color={theme.accent} /> : null}
        {q && !loading && !opening ? (
          <TouchableOpacity onPress={() => setQ('')}>
            <Ionicons name="close-circle" size={18} color={theme.textDim} />
          </TouchableOpacity>
        ) : null}
      </View>

      {!error && !searched && (
        <Text style={styles.searchHint}>
          Scrivi il nome (es. charizard, luffy) o il numero. Suggerimenti istantanei — Pokémon + One Piece.
        </Text>
      )}
      {error && <Text style={styles.searchHint}>{error}</Text>}
      {!loading && !error && searched && results.length === 0 && (
        <Text style={styles.searchHint}>Nessun risultato per “{q}”.</Text>
      )}

      {results.map(s => (
        <TouchableOpacity key={s.key} style={styles.sugg} onPress={() => openCard(s)} activeOpacity={0.7} disabled={opening}>
          {s.thumb ? (
            <Image source={{ uri: s.thumb }} style={styles.suggThumb} resizeMode="contain" />
          ) : (
            <View style={[styles.suggThumb, styles.thumbEmpty]}>
              <Ionicons name="image-outline" size={14} color={theme.textDim} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.suggName} numberOfLines={1}>{s.name}</Text>
            <Text style={styles.suggSub} numberOfLines={1}>{s.sub}</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={theme.textDim} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

export default function App() {
  const [tab, setTab] = useState(0);
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saved, setSaved] = useState([]);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    AsyncStorage.getItem('tcgradar.saved')
      .then(s => { if (s) setSaved(JSON.parse(s)); })
      .catch(() => {});
  }, []);

  const toggleSave = useCallback((item) => {
    setSaved(prev => {
      const exists = prev.some(s => s.ref === item.ref);
      const next = exists ? prev.filter(s => s.ref !== item.ref) : [item, ...prev];
      AsyncStorage.setItem('tcgradar.saved', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const isSaved = useCallback((ref) => saved.some(s => s.ref === ref), [saved]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(DATA_URL + '?t=' + Date.now());
      const json = await res.json();
      setData(json);
    } catch {
      setData(sampleData);
    }
    setRotation(r => r + 1);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (!data) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={theme.accent} size="large" />
      </View>
    );
  }

  if (detail) {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={theme.bg} />
        <DetailScreen
          item={detail}
          onBack={() => setDetail(null)}
          isSaved={isSaved(detail.ref)}
          onToggleSave={toggleSave}
        />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />

      <View style={styles.header}>
        <Text style={styles.logo}>⚓ TCG Radar</Text>
        <View style={styles.pulse}>
          <Text style={styles.pulseLabel}>Mercato </Text>
          <Text style={[styles.pulseValue, { color: changeColor(data.marketPulse) }]}>
            {pct(data.marketPulse)}
          </Text>
        </View>
      </View>

      <View style={styles.content}>
        {tab === 0 && <HomeTab data={data} rotation={rotation} onPress={setDetail} refreshing={refreshing} onRefresh={onRefresh} />}
        {tab === 1 && <WatchlistTab data={saved} onPress={setDetail} refreshing={refreshing} onRefresh={onRefresh} />}
        {tab === 2 && <NewsTab news={data.news} lastUpdate={data.lastUpdate} refreshing={refreshing} onRefresh={onRefresh} />}
        {tab === 3 && <SearchTab onPress={setDetail} />}
      </View>

      <View style={styles.tabbar}>
        {TAB_META.map((t, i) => (
          <TouchableOpacity key={t.label} style={styles.tabItem} onPress={() => setTab(i)} activeOpacity={0.7}>
            <Ionicons name={tab === i ? t.icon : t.iconOutline} size={22} color={tab === i ? theme.accent : theme.textDim} />
            <Text style={[styles.tabItemLabel, { color: tab === i ? theme.accent : theme.textDim }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  loading: { flex: 1, backgroundColor: theme.bg, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: 52, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: theme.border,
  },
  logo: { color: theme.accent, fontSize: font.lg, fontWeight: '700', letterSpacing: 1 },
  pulse: { flexDirection: 'row', alignItems: 'center' },
  pulseLabel: { color: theme.textDim, fontSize: font.sm },
  pulseValue: { fontSize: font.sm, fontWeight: '700' },
  content: { flex: 1 },
  listLabel: { color: theme.textDim, fontSize: font.xs, fontWeight: '600', marginTop: 14, marginBottom: 2, marginLeft: 14, letterSpacing: 0.3 },

  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: theme.card, marginHorizontal: 12, marginTop: 10,
    borderRadius: 10, padding: 14, borderWidth: 1, borderColor: theme.border,
  },
  rowLeft: { flex: 1, marginRight: 12 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { color: theme.text, fontSize: font.md, fontWeight: '700', flex: 1 },
  rowSub: { color: theme.textDim, fontSize: font.xs, marginTop: 2 },
  rowChange: { fontSize: font.md, fontWeight: '700', marginTop: 4 },
  rowRight: { alignItems: 'flex-end', gap: 4 },
  rowPrice: { color: theme.accent, fontSize: font.sm, fontWeight: '600' },

  badge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: font.xs, fontWeight: '700' },
  alertBadge: { backgroundColor: theme.accentDim, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  alertText: { color: theme.alert, fontSize: font.xs, fontWeight: '700' },

  detail: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 16 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 52, paddingBottom: 16 },
  backText: { color: theme.accent, fontSize: font.md },
  detailName: { color: theme.text, fontSize: font.xxl, fontWeight: '800' },
  detailSub: { color: theme.textDim, fontSize: font.sm, marginTop: 4 },
  detailImage: { width: 200, height: 280, alignSelf: 'center', marginTop: 16, marginBottom: 8 },
  sectionTitle: { color: theme.textDim, fontSize: font.sm, fontWeight: '600', marginBottom: 8, marginTop: 18 },

  priceBig: { backgroundColor: theme.card, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: theme.border },
  priceBigVal: { color: theme.accent, fontSize: font.xl, fontWeight: '800' },
  priceBigNote: { color: theme.textDim, fontSize: font.xs, marginTop: 4 },

  signalRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 4 },
  noteText: { color: theme.text, fontSize: font.sm, flex: 1, lineHeight: 20 },

  newsCard: {
    backgroundColor: theme.card, marginHorizontal: 12, marginTop: 10,
    borderRadius: 10, padding: 14, borderWidth: 1, borderColor: theme.border,
  },
  newsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  newsTag: { fontSize: font.sm },
  newsSource: { color: theme.textDim, fontSize: font.xs, flex: 1 },
  newsDate: { color: theme.textDim, fontSize: font.xs },
  newsTitle: { color: theme.text, fontSize: font.md, fontWeight: '700', marginBottom: 6 },
  newsDir: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  newsDirText: { fontSize: font.xs, fontWeight: '600' },
  chipRow: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card },
  chipOn: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  chipTxt: { color: theme.textDim, fontSize: font.sm, fontWeight: '600' },
  chipTxtOn: { color: theme.text },

  thumb: { width: 44, height: 60, borderRadius: 4, marginRight: 10, backgroundColor: theme.bg },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border },

  buyRow: { flexDirection: 'row', gap: 8 },
  buy3: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    borderWidth: 1, borderColor: theme.accent, borderRadius: 10, paddingVertical: 12,
  },
  buy3Primary: { backgroundColor: theme.accent },
  buy3Text: { fontSize: font.sm, fontWeight: '700' },

  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border,
    borderRadius: 10, paddingHorizontal: 12,
  },
  searchInput: { flex: 1, color: theme.text, fontSize: font.md, paddingVertical: 10 },
  searchHint: { color: theme.textDim, fontSize: font.sm, textAlign: 'center', marginTop: 24, paddingHorizontal: 24, lineHeight: 20 },
  emptyBox: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 10, flexGrow: 1 },
  sugg: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border,
  },
  suggThumb: { width: 30, height: 42, borderRadius: 3, backgroundColor: theme.bg },
  suggName: { color: theme.text, fontSize: font.md, fontWeight: '600' },
  suggSub: { color: theme.textDim, fontSize: font.xs, marginTop: 1 },

  radarBox: {
    marginHorizontal: 12, marginTop: 12, padding: 12,
    backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.accentDim,
  },
  radarHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  radarTitle: { color: theme.accent, fontSize: font.sm, fontWeight: '700', letterSpacing: 0.5 },
  radarRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 7, borderTopWidth: 1, borderTopColor: theme.border,
  },
  radarThumb: { width: 28, height: 39, borderRadius: 3, backgroundColor: theme.bg },
  radarName: { color: theme.text, fontSize: font.sm, fontWeight: '600' },
  radarReason: { color: theme.up, fontSize: font.xs, marginTop: 1 },
  radarPrice: { color: theme.accent, fontSize: font.sm, fontWeight: '600' },
  radarNote: { color: theme.textDim, fontSize: font.xs, marginTop: 8, fontStyle: 'italic' },

  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1, borderColor: theme.accent, borderRadius: 10, paddingVertical: 13, marginTop: 16,
  },
  saveText: { color: theme.accent, fontSize: font.md, fontWeight: '600' },

  tabbar: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: theme.border,
    backgroundColor: theme.surface, paddingTop: 8, paddingBottom: 24,
  },
  tabItem: { flex: 1, alignItems: 'center', gap: 3 },
  tabItemLabel: { fontSize: font.xs },

  tfRow: { flexDirection: 'row', gap: 8, marginBottom: 6, marginTop: 4 },
  tfChip: {
    flex: 1, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border,
    borderRadius: 8, paddingVertical: 8, alignItems: 'center',
  },
  tfLabel: { color: theme.textDim, fontSize: font.xs, marginBottom: 2 },
  tfVal: { fontSize: font.md, fontWeight: '700' },
  tfNote: { color: theme.textDim, fontSize: font.xs, textAlign: 'center', marginBottom: 12 },
  newsUpdated: { color: theme.textDim, fontSize: font.xs, textAlign: 'center', paddingVertical: 8 },
});
