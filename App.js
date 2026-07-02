import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, StatusBar, ScrollView, ActivityIndicator,
  Image, Linking, TextInput, Platform, BackHandler,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Sparkline from './Sparkline';
import Chart from './Chart';
import { theme, font } from './theme';
import sampleData from './sample.json';

const DATA_URL = 'https://chrx93.github.io/data.json'; // dati live pubblicati
const USD_EUR = 0.92; // cambio indicativo per stime in-app (le carte del motore sono gia' in EUR)

const TAB_META = [
  { label: 'Home', icon: 'home', iconOutline: 'home-outline' },
  { label: 'Portfolio', icon: 'briefcase', iconOutline: 'briefcase-outline' },
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

// Le notifiche del browser esistono solo sul web (e su iPhone solo se l'app è
// installata in Home, iOS 16.4+). Su Expo Go nativo non esiste -> guardia.
const canNotify = () => typeof window !== 'undefined' && 'Notification' in window;

// Personaggi "iconici": molto richiesti dal mercato -> domanda costante.
// NON è una garanzia di crescita, ma è un fattore di importanza reale.
const ICONIC = [
  // Pokémon
  'pikachu', 'charizard', 'gengar', 'mewtwo', 'mew', 'eevee', 'umbreon', 'espeon',
  'sylveon', 'vaporeon', 'jolteon', 'flareon', 'leafeon', 'glaceon', 'lugia', 'rayquaza',
  'gyarados', 'dragonite', 'gardevoir', 'lucario', 'greninja', 'snorlax', 'blastoise',
  'venusaur', 'tyranitar', 'garchomp', 'gardevoir', 'arceus', 'giratina', 'darkrai',
  // One Piece
  'luffy', 'zoro', 'nami', 'sanji', 'ace', 'law', 'shanks', 'yamato', 'robin', 'sabo',
  'boa hancock', 'hancock', 'doflamingo', 'katakuri', 'kid', 'kaido', 'big mom', 'roger',
  'rayleigh', 'sabo', 'nico robin', 'trafalgar', 'monkey d', 'gol d',
];

const iconicFor = (name) => {
  const n = (name || '').toLowerCase();
  return ICONIC.find(c => n.includes(c)) ? true : false;
};

const fmtTime = (ts) => {
  try { return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
};

const buyLinksFor = (item) => {
  const nm = item.name || '';
  const serial = item.serial || '';
  const q = encodeURIComponent(`${nm} ${serial}`);
  const base = {
    cardmarket: item.game === 'onepiece'
      ? 'https://www.cardmarket.com/en/OnePiece/Products/Search?searchString=' + encodeURIComponent(nm)
      : 'https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=' + encodeURIComponent(nm),
    ebay: 'https://www.ebay.it/sch/i.html?_nkw=' + q + '&_sop=15',
    cardtrader: 'https://www.cardtrader.com/en/search?q=' + encodeURIComponent(nm),
    vinted: 'https://www.vinted.it/catalog?order=price_low_to_high&search_text=' + q,
    auction: 'https://www.ebay.it/sch/i.html?_nkw=' + q + '&LH_Auction=1&_sop=1',
    sold: 'https://www.ebay.it/sch/i.html?_nkw=' + q + '&LH_Sold=1&LH_Complete=1&_sop=13',
    psa10: 'https://www.ebay.it/sch/i.html?_nkw=' + encodeURIComponent(`${nm} ${serial} PSA 10`) + '&_sop=15',
    psa10sold: 'https://www.ebay.it/sch/i.html?_nkw=' + encodeURIComponent(`${nm} ${serial} PSA 10`) + '&LH_Sold=1&LH_Complete=1&_sop=13',
  };
  // i link del motore (game-aware) hanno priorita'; base riempie quelli mancanti (venduti, ecc.)
  return { ...base, ...(item.buyLinks || {}) };
};

const MARKETS = [
  { key: 'ebay', label: 'eBay.it', icon: 'cart-outline' },
  { key: 'cardmarket', label: 'Cardmarket', icon: 'pricetag-outline' },
  { key: 'cardtrader', label: 'Cardtrader', icon: 'albums-outline' },
  { key: 'vinted', label: 'Vinted', icon: 'shirt-outline' },
];

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
  if (cm && eur != null && eur >= 5) {
    const chg = (avg) => {
      if (!avg) return null;
      const v = Math.round(((eur - avg) / avg) * 1000) / 10;
      return Math.abs(v) <= 30 ? v : null;
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
    illustrator: c.illustrator || null,
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

const CardRow = React.memo(function CardRow({ item, onPress, moved }) {
  const priceVal = toEur(item.prices);
  const hasMoved = moved != null && Math.abs(moved) >= 3;
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
          <Text style={styles.rowName} numberOfLines={1}>{iconicFor(item.name) ? '👑 ' : ''}{item.name}</Text>
          {hasMoved ? (
            <View style={[styles.movedPill, { backgroundColor: moved > 0 ? '#13351f' : '#3a1514' }]}>
              <Text style={[styles.movedText, { color: moved > 0 ? theme.up : theme.down }]}>
                🔔 {pct(moved)}
              </Text>
            </View>
          ) : null}
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
});

function PriceFinder({ item }) {
  const links = buyLinksFor(item);
  const bo = item.bestOffer;
  return (
    <>
      <Text style={styles.sectionTitle}>💰 Miglior prezzo</Text>
      {bo && bo.url ? (
        <View style={styles.bestBox}>
          <View style={{ flex: 1 }}>
            <Text style={styles.bestPrice}>{fmt(bo.total)}</Text>
            <Text style={styles.bestSub} numberOfLines={1}>
              eBay.it · {bo.seller || 'venditore'}{bo.condition ? ` · ${bo.condition}` : ''}{bo.ship ? ` · sped. ${fmt(bo.ship)}` : ' · sped. incl.'}
            </Text>
          </View>
          <TouchableOpacity style={styles.bestBtn} onPress={() => Linking.openURL(bo.url)} activeOpacity={0.85}>
            <Ionicons name="open-outline" size={15} color={theme.bg} />
            <Text style={styles.bestBtnText}>Annuncio</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={styles.tfNote}>Prezzo più basso eBay non disponibile ora — apri le ricerche qui sotto.</Text>
      )}

      {(() => {
        const sell = toEur(item.prices);
        if (bo && bo.total && sell && sell > bo.total * 1.15) {
          const mult = sell / bo.total;
          return (
            <View style={styles.resaleBox}>
              <Text style={styles.resaleTitle}>📊 Margine di rivendita</Text>
              <Text style={styles.resaleMain}>Compri a ~{fmt(bo.total)} → valore di mercato ~{fmt(sell)}</Text>
              <Text style={styles.resaleUp}>potenziale +{((mult - 1) * 100).toFixed(0)}% (×{mult.toFixed(1)})</Text>
              <Text style={styles.resaleNote}>Il valore di mercato è il prezzo medio richiesto, non garantito: contano condizioni, autenticità e commissioni di vendita.</Text>
            </View>
          );
        }
        return null;
      })()}

      <Text style={styles.sectionTitle}>Cerca al minor prezzo su</Text>
      <View style={styles.marketGrid}>
        {MARKETS.filter(m => links[m.key]).map(m => (
          <TouchableOpacity key={m.key} style={styles.marketBtn} onPress={() => Linking.openURL(links[m.key])} activeOpacity={0.85}>
            <Ionicons name={m.icon} size={16} color={theme.accent} />
            <Text style={styles.marketBtnText}>{m.label}</Text>
            <Ionicons name="chevron-forward" size={14} color={theme.textDim} />
          </TouchableOpacity>
        ))}
      </View>

      {links.auction ? (
        <TouchableOpacity style={[styles.auctionBtn, item.change7d >= 10 && styles.auctionBtnHot]} onPress={() => Linking.openURL(links.auction)} activeOpacity={0.85}>
          <Ionicons name="hammer-outline" size={16} color={theme.bg} />
          <Text style={styles.auctionText}>
            🔨 Aste in corso su eBay{item.change7d >= 10 ? ' · sta salendo, possibile occasione!' : ''}
          </Text>
        </TouchableOpacity>
      ) : null}

      {links.sold ? (
        <TouchableOpacity style={styles.soldBtn} onPress={() => Linking.openURL(links.sold)} activeOpacity={0.85}>
          <Ionicons name="stats-chart-outline" size={16} color={theme.text} />
          <Text style={styles.soldText}>📉 Prezzi venduti (eBay) — quanto si vende davvero</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.sectionTitle}>🏅 Conviene gradarla? (PSA 10)</Text>
      <View style={styles.gradeRow}>
        <TouchableOpacity style={styles.gradeBtn} onPress={() => Linking.openURL(links.psa10)} activeOpacity={0.85}>
          <Ionicons name="ribbon-outline" size={15} color={theme.accent} />
          <Text style={styles.gradeBtnText}>PSA 10 in vendita</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.gradeBtn} onPress={() => Linking.openURL(links.psa10sold)} activeOpacity={0.85}>
          <Ionicons name="stats-chart-outline" size={15} color={theme.accent} />
          <Text style={styles.gradeBtnText}>PSA 10 venduti</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.disclaimer}>
        Regola pratica: se un PSA 10 si vende per più del prezzo raw + ~€20 di gradazione, può convenire farla valutare. Guarda i "venduti" per numeri reali.
      </Text>
      <Text style={styles.disclaimer}>
        Solo eBay mostra automaticamente il prezzo più basso reale. Cardmarket, Cardtrader e Vinted
        aprono la ricerca ordinata dal più economico (non permettono la lettura automatica del prezzo;
        Vinted vieta lo scraping).
      </Text>
    </>
  );
}

function AddToPortfolio({ item, onAdd }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const cur = toEur(item.prices);
  const [price, setPrice] = useState(cur != null ? String(cur) : '');
  const [qty, setQty] = useState('1');
  const confirm = () => {
    const p = parseFloat(String(price).replace(',', '.'));
    const q = parseInt(qty, 10) || 1;
    if (!isNaN(p) && p > 0) { onAdd(item, p, q); setDone(true); setOpen(false); }
  };
  if (done) {
    return (
      <View style={styles.portfolioDone}>
        <Ionicons name="checkmark-circle" size={18} color={theme.up} />
        <Text style={styles.portfolioDoneText}>Aggiunta al portfolio — la trovi nella tab Portfolio</Text>
      </View>
    );
  }
  if (!open) {
    return (
      <TouchableOpacity style={styles.portfolioBtn} onPress={() => setOpen(true)} activeOpacity={0.85}>
        <Ionicons name="briefcase-outline" size={18} color={theme.bg} />
        <Text style={styles.portfolioBtnText}>Ho comprato questa carta</Text>
      </TouchableOpacity>
    );
  }
  return (
    <View style={styles.buyForm}>
      <Text style={styles.buyFormLabel}>Prezzo pagato (€) e quantità</Text>
      <View style={styles.buyFormRow}>
        <TextInput style={styles.buyInput} keyboardType="decimal-pad" value={price} onChangeText={setPrice} placeholder="€ pagato" placeholderTextColor={theme.textDim} />
        <TextInput style={[styles.buyInput, { flex: 0.5 }]} keyboardType="number-pad" value={qty} onChangeText={setQty} placeholder="qtà" placeholderTextColor={theme.textDim} />
        <TouchableOpacity style={styles.buyConfirm} onPress={confirm} activeOpacity={0.85}>
          <Text style={styles.buyConfirmText}>Salva</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function factorsFor(item) {
  const f = [];
  const price = toEur(item.prices);
  if (iconicFor(item.name)) f.push('👑 Personaggio iconico — domanda costante sul mercato');
  if (item.change7d >= 5) f.push(`📈 In salita: ${pct(item.change7d)} negli ultimi 7g`);
  if (item.inNews) f.push('📰 Se ne parla nelle notizie recenti');
  if (price != null && price <= 15) f.push('💶 Ancora economica: prezzo d’ingresso basso');
  const bo = item.bestOffer;
  if (bo && bo.total && price && price > bo.total * 1.15) {
    f.push(`💰 In giro c’è chi la vende sotto il valore di mercato (da ~${fmt(bo.total)})`);
  }
  return f;
}

function WhyWatch({ item }) {
  const factors = factorsFor(item);
  if (!factors.length) return null;
  return (
    <>
      <Text style={styles.sectionTitle}>Perché tenerla d'occhio</Text>
      <View style={styles.whyBox}>
        {factors.map((t, i) => <Text key={i} style={styles.whyItem}>{t}</Text>)}
        <Text style={styles.whyNote}>Sono fattori di mercato, non una garanzia di crescita.</Text>
      </View>
    </>
  );
}

function TargetForm({ item, target, onSave }) {
  const cur = toEur(item.prices);
  const [below, setBelow] = useState(target && target.below != null ? String(target.below) : '');
  const [above, setAbove] = useState(target && target.above != null ? String(target.above) : '');
  const save = () => {
    const b = parseFloat(String(below).replace(',', '.'));
    const a = parseFloat(String(above).replace(',', '.'));
    onSave(item.ref, { below: isNaN(b) ? null : b, above: isNaN(a) ? null : a });
  };
  let status = null;
  if (cur != null && target) {
    if (target.below != null && cur <= target.below) status = { t: `✅ Sotto la soglia d'acquisto ${fmt(target.below)} — buon momento per comprare`, c: theme.up };
    else if (target.above != null && cur >= target.above) status = { t: `✅ Sopra la soglia di vendita ${fmt(target.above)} — valuta di vendere`, c: theme.up };
    else if (target.below != null) status = { t: `Obiettivo acquisto ${fmt(target.below)} · ora ${fmt(cur)}`, c: theme.textDim };
    else if (target.above != null) status = { t: `Obiettivo vendita ${fmt(target.above)} · ora ${fmt(cur)}`, c: theme.textDim };
  }
  return (
    <View style={styles.targetBox}>
      <Text style={styles.targetLabel}>🎯 Avvisami quando il prezzo…</Text>
      <View style={styles.buyFormRow}>
        <TextInput style={styles.buyInput} keyboardType="decimal-pad" value={below} onChangeText={setBelow} placeholder="scende sotto €" placeholderTextColor={theme.textDim} />
        <TextInput style={styles.buyInput} keyboardType="decimal-pad" value={above} onChangeText={setAbove} placeholder="sale sopra €" placeholderTextColor={theme.textDim} />
        <TouchableOpacity style={styles.buyConfirm} onPress={save} activeOpacity={0.85}>
          <Text style={styles.buyConfirmText}>OK</Text>
        </TouchableOpacity>
      </View>
      {status ? <Text style={[styles.targetStatus, { color: status.c }]}>{status.t}</Text> : (
        <Text style={styles.targetHint}>Le carte seguite dal motore vengono controllate a ogni aggiornamento.</Text>
      )}
    </View>
  );
}

function DetailScreen({ item, onBack, isSaved, onToggleSave, onAddPortfolio, target, onSaveTarget }) {
  const priceVal = toEur(item.prices);
  const iconic = iconicFor(item.name);
  return (
    <ScrollView style={styles.detail} contentContainerStyle={{ paddingBottom: 40 }}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack}>
        <Ionicons name="arrow-back" size={20} color={theme.accent} />
        <Text style={styles.backText}>Indietro</Text>
      </TouchableOpacity>

      <Text style={styles.detailName}>{item.name}</Text>
      <Text style={styles.detailSub}>{item.set} · {item.rarity}{item.serial ? ` · ${item.serial}` : ''}</Text>
      {iconic ? <Text style={styles.iconicTag}>👑 Personaggio iconico</Text> : null}
      {item.illustrator ? <Text style={styles.illTag}>🎨 Illustratore: {item.illustrator}</Text> : null}

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

      {item.range && item.range.high > item.range.low && priceVal != null ? (
        <View style={styles.rangeBox}>
          <View style={styles.rangeBar}>
            <View style={[styles.rangeFill, { width: `${Math.min(100, Math.max(0, ((priceVal - item.range.low) / (item.range.high - item.range.low)) * 100))}%` }]} />
          </View>
          <View style={styles.rangeLabels}>
            <Text style={styles.rangeLbl}>min {fmt(item.range.low)}</Text>
            <Text style={styles.rangeLbl}>max {fmt(item.range.high)}</Text>
          </View>
          <Text style={styles.rangeNote}>
            Sei al {Math.round(((priceVal - item.range.low) / (item.range.high - item.range.low)) * 100)}% tra minimo e massimo dello storico raccolto finora.
          </Text>
        </View>
      ) : null}

      <WhyWatch item={item} />

      {item.note ? (
        <>
          <Text style={styles.sectionTitle}>Note</Text>
          <Text style={styles.noteText}>{item.note}</Text>
        </>
      ) : null}

      <TouchableOpacity style={styles.saveBtn} onPress={() => onToggleSave(item)} activeOpacity={0.8}>
        <Ionicons name={isSaved ? 'checkmark-circle' : 'add-circle-outline'} size={18} color={theme.accent} />
        <Text style={styles.saveText}>{isSaved ? 'Nella watchlist — tocca per rimuovere' : 'Aggiungi alla watchlist'}</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>💼 Compravendita</Text>
      <AddToPortfolio item={item} onAdd={onAddPortfolio} />

      <TargetForm item={item} target={target} onSave={onSaveTarget} />

      <PriceFinder item={item} />
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

function RampSection({ cards, onPress }) {
  if (!cards || !cards.length) return null;
  return (
    <View style={styles.rampBox}>
      <View style={styles.radarHeader}>
        <Text style={styles.rampTitle}>🚀 IN RAMPA · economiche in salita</Text>
      </View>
      {cards.map(item => (
        <TouchableOpacity key={item.ref} style={styles.radarRow} onPress={() => onPress(item)} activeOpacity={0.7}>
          {item.image ? (
            <Image source={{ uri: item.image }} style={styles.radarThumb} resizeMode="contain" />
          ) : <View style={[styles.radarThumb, styles.thumbEmpty]} />}
          <View style={{ flex: 1 }}>
            <Text style={styles.radarName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.rampReason} numberOfLines={1}>{pct(item.change7d)} 7g · ancora sotto {fmt(25)}</Text>
          </View>
          <Text style={styles.radarPrice}>{fmt(toEur(item.prices))}</Text>
        </TouchableOpacity>
      ))}
      <Text style={styles.radarNote}>In salita e ancora economiche: da valutare prima che salgano. Non è una garanzia.</Text>
    </View>
  );
}

function HomeTab({ data, rotation, onPress, refreshing, onRefresh }) {
  const movers = useMemo(
    () => [...(data.items || [])].sort((a, b) => Math.abs(b.change7d) - Math.abs(a.change7d)),
    [data]
  );
  const ramp = useMemo(
    () => (data.items || [])
      .filter(i => i.change7d >= 5 && (toEur(i.prices) ?? 999) <= 25)
      .sort((a, b) => b.change7d - a.change7d)
      .slice(0, 5),
    [data]
  );
  const today = useMemo(() => {
    const items = data.items || [];
    const up = items.filter(i => i.change7d >= 3);
    const down = items.filter(i => i.change7d <= -3);
    return {
      up: up.length, down: down.length,
      tUp: up.slice().sort((a, b) => b.change7d - a.change7d)[0],
      tDown: down.slice().sort((a, b) => a.change7d - b.change7d)[0],
    };
  }, [data]);
  const radarCards = useMemo(() => {
    const byRef = {};
    (data.items || []).forEach(i => { byRef[i.ref] = i; });
    const pool = (data.radar || []).map(r => byRef[r]).filter(Boolean);
    if (!pool.length) return [];
    const k = rotation % pool.length;
    return pool.slice(k).concat(pool.slice(0, k)).slice(0, 6);
  }, [data, rotation]);
  return (
    <FlatList
      data={movers}
      keyExtractor={i => i.ref}
      ListHeaderComponent={
        <>
          <View style={styles.todayStrip}>
            <Text style={styles.todayMain}>
              📊 Oggi: <Text style={{ color: theme.up, fontWeight: '800' }}>{today.up} in salita</Text> · <Text style={{ color: theme.down, fontWeight: '800' }}>{today.down} in calo</Text>
            </Text>
            {today.tUp ? (
              <Text style={styles.todaySub} numberOfLines={1}>
                🔥 {today.tUp.name} {pct(today.tUp.change7d)}{today.tDown ? `   ❄️ ${today.tDown.name} ${pct(today.tDown.change7d)}` : ''}
              </Text>
            ) : null}
          </View>
          <RampSection cards={ramp} onPress={onPress} />
          <RadarSection cards={radarCards} onPress={onPress} />
          <Text style={styles.listLabel}>Tutte le carte · variazione 7g</Text>
        </>
      }
      renderItem={({ item }) => <CardRow item={item} onPress={onPress} />}
      contentContainerStyle={{ paddingBottom: 20 }}
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={11}
      removeClippedSubviews={Platform.OS !== 'web'}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
    />
  );
}

function NotifToggle({ notifOn, onToggleNotif }) {
  if (!canNotify()) return null;
  return (
    <TouchableOpacity style={[styles.notifBtn, notifOn && styles.notifBtnOn]} onPress={onToggleNotif} activeOpacity={0.8}>
      <Ionicons name={notifOn ? 'notifications' : 'notifications-outline'} size={15} color={notifOn ? theme.bg : theme.accent} />
      <Text style={[styles.notifText, { color: notifOn ? theme.bg : theme.accent }]}>
        {notifOn ? 'Notifiche attive' : 'Attiva notifiche'}
      </Text>
    </TouchableOpacity>
  );
}

function WatchlistTab({ data, onPress, refreshing, onRefresh, notifOn, onToggleNotif }) {
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
  const movers = data.filter(c => c.movedPct != null && Math.abs(c.movedPct) >= 3).length;
  return (
    <FlatList
      data={data}
      keyExtractor={i => i.ref}
      ListHeaderComponent={
        <View>
          <Text style={styles.watchBanner}>
            {movers > 0
              ? `🔔 ${movers} ${movers === 1 ? 'carta si è mossa' : 'carte si sono mosse'} dall'ultima visita`
              : 'Nessun movimento dall’ultima visita · tira giù per aggiornare'}
          </Text>
          <View style={{ alignItems: 'center', marginBottom: 6 }}>
            <NotifToggle notifOn={notifOn} onToggleNotif={onToggleNotif} />
          </View>
        </View>
      }
      renderItem={({ item }) => <CardRow item={item} onPress={onPress} moved={item.movedPct} />}
      contentContainerStyle={{ paddingBottom: 20 }}
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={11}
      removeClippedSubviews={Platform.OS !== 'web'}
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

function NewsTab({ news, lastUpdate, lastChecked, refreshing, onRefresh }) {
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
            {all.length} notizie · generate {lastUpdate ? fmtTime(lastUpdate) : '—'} · controllato {fmtTime(lastChecked)}
          </Text>
          <Text style={styles.newsUpdated2}>
            tira giù (o 🔄 in alto) per ricontrollare · le notizie si rigenerano ogni ~30 min
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
            <Text style={styles.newsTitle}>{item.titleIt || item.title}</Text>
            {item.titleIt ? <Text style={styles.newsOrig} numberOfLines={1}>originale: {item.title}</Text> : null}
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

function ArtistsView({ artists, onOpen }) {
  const [sel, setSel] = useState(null);
  const [opening, setOpening] = useState(false);
  const list = artists || [];
  if (!list.length) {
    return <Text style={styles.searchHint}>Studio artisti in preparazione — si costruisce dai rari recenti, riprova tra poco.</Text>;
  }
  const open = async (id) => { setOpening(true); try { await onOpen({ src: 'pkm', id }); } catch {} setOpening(false); };

  if (sel) {
    return (
      <View style={{ marginTop: 12 }}>
        <TouchableOpacity style={styles.catBack} onPress={() => setSel(null)} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={16} color={theme.accent} />
          <Text style={styles.catBackText} numberOfLines={1}>Tutti gli artisti · {sel.name}</Text>
        </TouchableOpacity>
        <Text style={styles.artStat}>{sel.count} carte di valore · media {fmt(sel.avg)} · max {fmt(sel.max)}</Text>
        <View style={[styles.catGrid, { marginTop: 10 }]}>
          {sel.cards.map((c, i) => (
            <TouchableOpacity key={i} style={styles.catCard} onPress={() => open(c.id)} activeOpacity={0.7} disabled={opening}>
              {c.image ? <Image source={{ uri: c.image }} style={styles.catThumb} resizeMode="contain" /> : <View style={[styles.catThumb, styles.thumbEmpty]} />}
              <Text style={styles.catCardName} numberOfLines={1}>{c.name}</Text>
              <Text style={styles.catCardPrice}>{fmt(c.price)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  }

  const maxAvg = Math.max(...list.map(a => a.avg)) || 1;
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.catTitle}>🎨 Artisti per valore delle carte</Text>
      <Text style={styles.artIntro}>Illustratori i cui rari recenti valgono di più: il disegno conta. Campione dai set recenti, cresce nel tempo.</Text>
      {list.map((a, i) => (
        <TouchableOpacity key={i} style={styles.artRow} onPress={() => setSel(a)} activeOpacity={0.7}>
          <Text style={styles.artRank}>{i + 1}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.artName} numberOfLines={1}>{a.name}</Text>
            <Text style={styles.artSub}>{a.count} carte · media {fmt(a.avg)} · max {fmt(a.max)}</Text>
            <View style={styles.artBarBg}><View style={[styles.artBarFill, { width: `${Math.max(6, (a.avg / maxAvg) * 100)}%` }]} /></View>
          </View>
          <Ionicons name="chevron-forward" size={16} color={theme.textDim} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

function CatalogBrowser({ game, onOpen }) {
  const [sets, setSets] = useState([]);
  const [loadingSets, setLoadingSets] = useState(false);
  const [sel, setSel] = useState(null);
  const [cards, setCards] = useState([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [opening, setOpening] = useState(false);
  const [sort, setSort] = useState('num');

  const sortedCards = useMemo(() => {
    const arr = [...cards];
    if (sort === 'price_desc') arr.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
    else if (sort === 'price_asc') arr.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
    else if (sort === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else arr.sort((a, b) => (typeof a.num === 'number' ? a.num - b.num : String(a.num).localeCompare(String(b.num))));
    return arr;
  }, [cards, sort]);
  const SORTS = game === 'op'
    ? [['num', 'Numero'], ['price_desc', 'Prezzo ↓'], ['price_asc', 'Prezzo ↑']]
    : [['num', 'Numero'], ['name', 'Nome']];

  useEffect(() => {
    let cancelled = false;
    setSel(null); setCards([]); setSets([]); setLoadingSets(true);
    (async () => {
      try {
        if (game === 'pkm') {
          const a = await (await fetch('https://api.tcgdex.net/v2/en/sets')).json();
          const list = (Array.isArray(a) ? a : []).map(s => ({
            id: s.id, name: s.name,
            count: (s.cardCount && (s.cardCount.official || s.cardCount.total)) || null,
            logo: s.logo ? s.logo + '.png' : null,
          })).reverse();
          if (!cancelled) setSets(list);
        } else {
          const a = await (await fetch('https://optcgapi.com/api/allSets/')).json();
          const list = (Array.isArray(a) ? a : []).map(s => ({ id: s.set_id, name: s.set_name, count: null, logo: null }));
          if (!cancelled) setSets(list);
        }
      } catch { if (!cancelled) setSets([]); }
      if (!cancelled) setLoadingSets(false);
    })();
    return () => { cancelled = true; };
  }, [game]);

  useEffect(() => {
    if (!sel) return;
    let cancelled = false;
    setCards([]); setLoadingCards(true);
    (async () => {
      try {
        if (game === 'pkm') {
          const d = await (await fetch('https://api.tcgdex.net/v2/en/sets/' + sel.id)).json();
          const list = (d && Array.isArray(d.cards) ? d.cards : []).map(c => ({
            spec: { src: 'pkm', id: c.id }, name: c.name,
            thumb: c.image ? c.image + '/low.png' : null,
            num: parseInt(c.localId, 10) || 0, price: null,
          }));
          if (!cancelled) setCards(list);
        } else {
          const a = await (await fetch('https://optcgapi.com/api/sets/' + sel.id + '/')).json();
          const list = (Array.isArray(a) ? a : []).map(c => ({
            spec: { src: 'op', raw: c }, name: c.card_name, thumb: c.card_image || null,
            num: c.card_set_id || '', price: parseFloat(String(c.market_price || '').replace(/[^0-9.]/g, '')) || null,
          }));
          if (!cancelled) setCards(list);
        }
      } catch { if (!cancelled) setCards([]); }
      if (!cancelled) setLoadingCards(false);
    })();
    return () => { cancelled = true; };
  }, [sel, game]);

  const open = async (spec) => { setOpening(true); try { await onOpen(spec); } catch {} setOpening(false); };

  if (loadingSets) return <ActivityIndicator color={theme.accent} style={{ marginTop: 30 }} />;

  if (sel) {
    return (
      <View style={{ marginTop: 12 }}>
        <TouchableOpacity style={styles.catBack} onPress={() => setSel(null)} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={16} color={theme.accent} />
          <Text style={styles.catBackText} numberOfLines={1}>Tutti i set · {sel.name}</Text>
        </TouchableOpacity>
        {loadingCards ? <ActivityIndicator color={theme.accent} style={{ marginTop: 20 }} /> : (
          <>
            <View style={styles.srcChips}>
              <Text style={styles.sortLabel}>Ordina:</Text>
              {SORTS.map(([k, lab]) => {
                const on = k === sort;
                return (
                  <TouchableOpacity key={k} style={[styles.chip, on && styles.chipOn]} onPress={() => setSort(k)} activeOpacity={0.7}>
                    <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{lab}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={[styles.catGrid, { marginTop: 12 }]}>
              {sortedCards.map((c, i) => (
                <TouchableOpacity key={i} style={styles.catCard} onPress={() => open(c.spec)} activeOpacity={0.7} disabled={opening}>
                  {c.thumb ? <Image source={{ uri: c.thumb }} style={styles.catThumb} resizeMode="contain" />
                    : <View style={[styles.catThumb, styles.thumbEmpty]} />}
                  <Text style={styles.catCardName} numberOfLines={1}>{iconicFor(c.name) ? '👑 ' : ''}{c.name}</Text>
                  {c.price != null ? <Text style={styles.catCardPrice}>{fmt(Math.round(c.price * USD_EUR * 100) / 100)}</Text> : null}
                </TouchableOpacity>
              ))}
              {!cards.length && <Text style={styles.searchHint}>Nessuna carta in questo set.</Text>}
            </View>
          </>
        )}
      </View>
    );
  }

  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.catTitle}>Catalogo {game === 'pkm' ? 'Pokémon' : 'One Piece'} · {sets.length} set</Text>
      {sets.map(s => (
        <TouchableOpacity key={s.id} style={styles.catSetRow} onPress={() => setSel(s)} activeOpacity={0.7}>
          {s.logo ? <Image source={{ uri: s.logo }} style={styles.catSetLogo} resizeMode="contain" />
            : <View style={[styles.catSetLogo, styles.thumbEmpty]}><Ionicons name="albums-outline" size={16} color={theme.textDim} /></View>}
          <Text style={styles.catSetName} numberOfLines={1}>{s.name}</Text>
          {s.count ? <Text style={styles.catSetCount}>{s.count}</Text> : null}
          <Ionicons name="chevron-forward" size={16} color={theme.textDim} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

function SearchTab({ onPress, artists }) {
  const [q, setQ] = useState('');
  const [browseMode, setBrowseMode] = useState('set');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);
  const [src, setSrc] = useState('all'); // 'all' | 'op' | 'pkm'
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setSearched(false); setError(null); setLoading(false); setRefreshing(false); return; }
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

      if (src !== 'op' && isNum) {
        tasks.push(fetch('https://api.tcgdex.net/v2/en/cards?localId=' + term)
          .then(r => r.json())
          .then(a => (Array.isArray(a) ? a : []).slice(0, 20).map(c => ({
            key: 'pk' + c.id, src: 'pkm', id: c.id, name: c.name,
            sub: 'Pokémon · #' + (c.localId || ''),
            thumb: c.image ? c.image + '/low.png' : null,
          }))).catch(() => []));
      } else if (src !== 'op' && longest) {
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

      if (src !== 'pkm' && opCode) {
        tasks.push(fetch('https://optcgapi.com/api/sets/card/' + opCode + '/')
          .then(r => r.json())
          .then(d => (Array.isArray(d) ? d : [d]).filter(Boolean).map((c, i) => ({
            key: 'op' + c.card_set_id + i, src: 'op', raw: c, name: c.card_name,
            sub: 'One Piece · ' + c.card_set_id, thumb: c.card_image || null,
          }))).catch(() => []));
      } else if (src !== 'pkm' && longest) {
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
      if (!cancelled) { setLoading(false); setRefreshing(false); }
    }, 280);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [q, src, nonce]);

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

  const SRC_CHIPS = [
    { key: 'all', label: 'Tutti' },
    { key: 'op', label: '🏴‍☠️ One Piece' },
    { key: 'pkm', label: '⚡ Pokémon' },
  ];

  return (
    <ScrollView
      style={{ paddingHorizontal: 12, paddingTop: 12 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); setNonce(n => n + 1); }} tintColor={theme.accent} />}
    >
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

      <View style={styles.srcChips}>
        {SRC_CHIPS.map(c => {
          const on = c.key === src;
          return (
            <TouchableOpacity key={c.key} style={[styles.chip, on && styles.chipOn]} onPress={() => setSrc(c.key)} activeOpacity={0.7}>
              <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{c.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {q.trim().length >= 2 ? (
        <>
          {error && <Text style={styles.searchHint}>{error}</Text>}
          {!loading && !error && results.length === 0 && (
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
        </>
      ) : src === 'all' ? (
        <Text style={styles.searchHint}>
          Scrivi un nome (es. charizard, luffy) o un numero — oppure scegli 🏴‍☠️ One Piece o ⚡ Pokémon qui sopra per sfogliare tutto il catalogo per set (e gli artisti).
        </Text>
      ) : (
        <>
          {src === 'pkm' && (
            <View style={[styles.srcChips, { marginTop: 12 }]}>
              {[['set', '📚 Set'], ['artists', '🎨 Artisti']].map(([k, lab]) => {
                const on = k === browseMode;
                return (
                  <TouchableOpacity key={k} style={[styles.chip, on && styles.chipOn]} onPress={() => setBrowseMode(k)} activeOpacity={0.7}>
                    <Text style={[styles.chipTxt, on && styles.chipTxtOn]}>{lab}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          {src === 'pkm' && browseMode === 'artists'
            ? <ArtistsView artists={artists} onOpen={openCard} />
            : <CatalogBrowser game={src} onOpen={openCard} />}
        </>
      )}
    </ScrollView>
  );
}

function BackupSection({ onExport, onImport }) {
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);
  const [txt, setTxt] = useState('');
  const doExport = async () => {
    const data = onExport();
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(data);
        setMsg('Backup copiato negli appunti ✓ — incollalo in un posto sicuro (note/email).');
        return;
      }
    } catch {}
    setTxt(data); setOpen(true); setMsg('Copia e salva il testo qui sotto.');
  };
  const doImport = () => {
    setMsg(onImport(txt.trim()) ? 'Dati ripristinati ✓' : 'Testo di backup non valido.');
  };
  return (
    <View style={styles.backupBox}>
      <Text style={styles.listLabel}>💾 Backup dei tuoi dati</Text>
      <Text style={styles.backupHint}>Portfolio, watchlist, soglie e vendite sono salvati solo su questo dispositivo. Esporta per non perderli o spostarli su un altro device.</Text>
      <View style={styles.buyRow}>
        <TouchableOpacity style={[styles.buy3, styles.buy3Primary]} onPress={doExport} activeOpacity={0.85}>
          <Ionicons name="download-outline" size={16} color={theme.bg} />
          <Text style={[styles.buy3Text, { color: theme.bg }]}>Esporta</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.buy3} onPress={() => setOpen(o => !o)} activeOpacity={0.85}>
          <Ionicons name="cloud-upload-outline" size={16} color={theme.accent} />
          <Text style={styles.buy3Text}>Importa</Text>
        </TouchableOpacity>
      </View>
      {open ? (
        <View style={{ marginTop: 10 }}>
          <TextInput style={styles.backupInput} value={txt} onChangeText={setTxt} placeholder="Incolla qui il backup…" placeholderTextColor={theme.textDim} multiline />
          <TouchableOpacity style={[styles.buyConfirm, { alignSelf: 'flex-start', marginTop: 8 }]} onPress={doImport} activeOpacity={0.85}>
            <Text style={styles.buyConfirmText}>Ripristina</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {msg ? <Text style={styles.backupMsg}>{msg}</Text> : null}
    </View>
  );
}

function Donut({ segments, size = 92, stroke = 16 }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2, cy = size / 2;
  let offset = 0;
  return (
    <Svg width={size} height={size}>
      <Circle cx={cx} cy={cy} r={r} fill="none" stroke={theme.bg} strokeWidth={stroke} />
      {segments.map((s, i) => {
        const len = (s.value / total) * c;
        const el = (
          <Circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
            strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
            transform={`rotate(-90 ${cx} ${cy})`} />
        );
        offset += len;
        return el;
      })}
    </Svg>
  );
}

function PortfolioTab({ holdings, sales, pfHist, data, onPress, onRemove, onSell, onRemoveSale, onExport, onImport, refreshing, onRefresh }) {
  const [extra, setExtra] = useState({}); // prezzi live per carte non tracciate dal motore
  const [sellingId, setSellingId] = useState(null);
  const [sellPrice, setSellPrice] = useState('');
  const closed = sales || [];
  const liveByRef = useMemo(() => {
    const m = {};
    (data && data.items ? data.items : []).forEach(i => { m[i.ref] = i; });
    return m;
  }, [data]);

  // Recupera il prezzo attuale per le carte non presenti nel motore (aggiunte dalla ricerca).
  useEffect(() => {
    let cancelled = false;
    const need = holdings.filter(h => !liveByRef[h.ref] && extra[h.ref] === undefined);
    if (!need.length) return;
    (async () => {
      const updates = {};
      for (const h of need) {
        try {
          if (h.game === 'onepiece') {
            const code = h.serial || h.ref;
            const r = await fetch('https://optcgapi.com/api/sets/card/' + encodeURIComponent(code) + '/');
            const d = await r.json();
            const c = Array.isArray(d) ? d[0] : d;
            const n = c ? parseFloat(String(c.market_price || '').replace(/[^0-9.]/g, '')) : NaN;
            updates[h.ref] = isNaN(n) ? null : Math.round(n * USD_EUR * 100) / 100;
          } else {
            const r = await fetch('https://api.tcgdex.net/v2/en/cards/' + encodeURIComponent(h.ref));
            const c = await r.json();
            updates[h.ref] = toEur(mapTcgdexCard(c).prices);
          }
        } catch { updates[h.ref] = null; }
      }
      if (!cancelled) setExtra(prev => ({ ...prev, ...updates }));
    })();
    return () => { cancelled = true; };
  }, [holdings, liveByRef]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentOf = (h) => {
    const live = liveByRef[h.ref];
    if (live) return toEur(live.prices);
    return extra[h.ref] != null ? extra[h.ref] : null;
  };

  let invested = 0, value = 0;
  holdings.forEach(h => {
    invested += h.buyPrice * h.qty;
    const c = currentOf(h);
    value += (c != null ? c : h.buyPrice) * h.qty;
  });
  const pl = value - invested;
  const plPct = invested > 0 ? (pl / invested) * 100 : 0;
  const realized = closed.reduce((s, x) => s + (x.realized || 0), 0);

  const byGame = {};
  holdings.forEach(h => {
    const cur = currentOf(h);
    byGame[h.game] = (byGame[h.game] || 0) + (cur != null ? cur : h.buyPrice) * h.qty;
  });
  const segs = [
    { label: '⚡ Pokémon', color: theme.accent, value: byGame.pokemon || 0 },
    { label: '🏴‍☠️ One Piece', color: theme.fattoText, value: byGame.onepiece || 0 },
  ].filter(s => s.value > 0);
  const segTotal = segs.reduce((s, x) => s + x.value, 0) || 1;

  if (!holdings.length && !closed.length) {
    return (
      <ScrollView contentContainerStyle={styles.emptyBox}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}>
        <Ionicons name="briefcase-outline" size={40} color={theme.textDim} />
        <Text style={styles.searchHint}>
          Il tuo portfolio è vuoto. Apri una carta e tocca “Ho comprato questa carta” per tracciare prezzo d'acquisto, valore attuale, guadagno e — quando vendi — il profitto realizzato.
        </Text>
        <View style={{ alignSelf: 'stretch' }}>
          <BackupSection onExport={onExport} onImport={onImport} />
        </View>
      </ScrollView>
    );
  }

  return (
    <FlatList
      data={holdings}
      keyExtractor={h => h.id}
      ListHeaderComponent={
        <>
          <View style={styles.pfSummary}>
            <View style={styles.pfSumRow}>
              <View><Text style={styles.pfSumLabel}>Investito</Text><Text style={styles.pfSumVal}>{fmt(invested)}</Text></View>
              <View><Text style={styles.pfSumLabel}>Valore ora</Text><Text style={styles.pfSumVal}>{fmt(value)}</Text></View>
              <View>
                <Text style={styles.pfSumLabel}>Non realizzato</Text>
                <Text style={[styles.pfSumVal, { color: changeColor(pl) }]}>{pl >= 0 ? '+' : ''}{fmt(pl)} ({pct(plPct)})</Text>
              </View>
            </View>
            {closed.length ? (
              <View style={styles.pfRealized}>
                <Text style={styles.pfSumLabel}>Profitto realizzato ({closed.length} {closed.length === 1 ? 'vendita' : 'vendite'})</Text>
                <Text style={[styles.pfSumVal, { color: changeColor(realized) }]}>{realized >= 0 ? '+' : ''}{fmt(realized)}</Text>
              </View>
            ) : null}
          </View>
          {segs.length ? (
            <View style={styles.allocBox}>
              <Donut segments={segs} />
              <View style={{ flex: 1, gap: 8 }}>
                <Text style={styles.allocTitle}>Allocazione</Text>
                {segs.map((s, i) => (
                  <View key={i} style={styles.allocRow}>
                    <View style={[styles.allocDot, { backgroundColor: s.color }]} />
                    <Text style={styles.allocLabel} numberOfLines={1}>{s.label}</Text>
                    <Text style={styles.allocPct}>{Math.round((s.value / segTotal) * 100)}% · {fmt(s.value)}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
          {pfHist && pfHist.length >= 2 ? (
            <View style={styles.pfChartBox}>
              <Text style={styles.allocTitle}>📈 Andamento del tuo portfolio</Text>
              <Chart series={pfHist} height={150} />
            </View>
          ) : null}
        </>
      }
      renderItem={({ item: h }) => {
        const cur = currentOf(h);
        const hpl = cur != null ? (cur - h.buyPrice) * h.qty : null;
        const hpct = (cur != null && h.buyPrice > 0) ? ((cur - h.buyPrice) / h.buyPrice) * 100 : null;
        const hint = (hpct == null) ? null : hpct >= 20 ? '📈 buon momento per vendere' : hpct <= -15 ? '📉 in perdita' : null;
        const selling = sellingId === h.id;
        return (
          <View>
            <View style={styles.pfRow}>
              <TouchableOpacity style={{ flexDirection: 'row', flex: 1, alignItems: 'center' }} onPress={() => onPress({ ...(liveByRef[h.ref] || h) })} activeOpacity={0.75}>
                {h.image ? <Image source={{ uri: h.image }} style={styles.thumb} resizeMode="contain" />
                  : <View style={[styles.thumb, styles.thumbEmpty]}><Ionicons name="image-outline" size={20} color={theme.textDim} /></View>}
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={styles.rowName} numberOfLines={1}>{h.name}{h.qty > 1 ? ` ×${h.qty}` : ''}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>pagata {fmt(h.buyPrice)} · ora {cur != null ? fmt(cur) : '—'}</Text>
                  {hint ? <Text style={[styles.pfHint, { color: hpct >= 0 ? theme.up : theme.down }]}>{hint}</Text> : null}
                </View>
              </TouchableOpacity>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[styles.pfPl, { color: changeColor(hpl) }]}>{hpl == null ? '—' : (hpl >= 0 ? '+' : '') + fmt(hpl)}</Text>
                <Text style={[styles.rowSub, { color: changeColor(hpct) }]}>{hpct == null ? '' : pct(hpct)}</Text>
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 5 }}>
                  <TouchableOpacity onPress={() => { setSellPrice(cur != null ? String(cur) : ''); setSellingId(selling ? null : h.id); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="cash-outline" size={17} color={theme.accent} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => onRemove(h.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="trash-outline" size={16} color={theme.textDim} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>
            {selling ? (
              <View style={styles.sellForm}>
                <Text style={styles.buyFormLabel}>Vendi — prezzo incassato (€){h.qty > 1 ? ` per ${h.qty} pezzi` : ''}</Text>
                <View style={styles.buyFormRow}>
                  <TextInput style={styles.buyInput} keyboardType="decimal-pad" value={sellPrice} onChangeText={setSellPrice} placeholder="€ venduto" placeholderTextColor={theme.textDim} />
                  <TouchableOpacity style={styles.buyConfirm} onPress={() => { const p = parseFloat(String(sellPrice).replace(',', '.')); if (!isNaN(p) && p >= 0) { onSell(h.id, p); setSellingId(null); } }} activeOpacity={0.85}>
                    <Text style={styles.buyConfirmText}>Registra</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
          </View>
        );
      }}
      ListFooterComponent={
        <>
          {closed.length ? (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.listLabel}>Operazioni chiuse · realizzato {realized >= 0 ? '+' : ''}{fmt(realized)}</Text>
            {closed.map(s => (
              <View key={s.id} style={styles.pfRow}>
                {s.image ? <Image source={{ uri: s.image }} style={styles.thumb} resizeMode="contain" />
                  : <View style={[styles.thumb, styles.thumbEmpty]}><Ionicons name="image-outline" size={20} color={theme.textDim} /></View>}
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={styles.rowName} numberOfLines={1}>{s.name}{s.qty > 1 ? ` ×${s.qty}` : ''}</Text>
                  <Text style={styles.rowSub} numberOfLines={1}>comprata {fmt(s.buyPrice)} → venduta {fmt(s.sellPrice)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[styles.pfPl, { color: changeColor(s.realized) }]}>{s.realized >= 0 ? '+' : ''}{fmt(s.realized)}</Text>
                  <TouchableOpacity onPress={() => onRemoveSale(s.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="trash-outline" size={14} color={theme.textDim} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
          ) : null}
          <BackupSection onExport={onExport} onImport={onImport} />
        </>
      }
      contentContainerStyle={{ paddingBottom: 20 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
    />
  );
}

export default function App() {
  const [tab, setTab] = useState(0);
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saved, setSaved] = useState([]);
  const [seen, setSeen] = useState({}); // ref -> ultimo prezzo visto in watchlist
  const [rotation, setRotation] = useState(0);
  const [notifOn, setNotifOn] = useState(false);
  const [portfolio, setPortfolio] = useState([]);
  const [sales, setSales] = useState([]); // operazioni chiuse (vendite)
  const [pfHist, setPfHist] = useState([]); // storico valore totale portfolio [[iso, valore]]
  const [targets, setTargets] = useState({}); // ref -> {below, above}
  const [lastChecked, setLastChecked] = useState(Date.now());
  const prevTab = useRef(0);
  const notifiedRef = useRef(new Set());
  const targetNotifiedRef = useRef(new Set());

  useEffect(() => {
    AsyncStorage.getItem('tcgradar.saved')
      .then(s => { if (s) setSaved(JSON.parse(s)); })
      .catch(() => {});
    AsyncStorage.getItem('tcgradar.seen')
      .then(s => { if (s) setSeen(JSON.parse(s)); })
      .catch(() => {});
    AsyncStorage.getItem('tcgradar.notif')
      .then(s => { if (s === '1' && canNotify() && Notification.permission === 'granted') setNotifOn(true); })
      .catch(() => {});
    AsyncStorage.getItem('tcgradar.portfolio')
      .then(s => { if (s) setPortfolio(JSON.parse(s)); })
      .catch(() => {});
    AsyncStorage.getItem('tcgradar.targets')
      .then(s => { if (s) setTargets(JSON.parse(s)); })
      .catch(() => {});
    AsyncStorage.getItem('tcgradar.sales')
      .then(s => { if (s) setSales(JSON.parse(s)); })
      .catch(() => {});
    AsyncStorage.getItem('tcgradar.pfhist')
      .then(s => { if (s) setPfHist(JSON.parse(s)); })
      .catch(() => {});
  }, []);

  const setTarget = useCallback((ref, next) => {
    setTargets(prev => {
      const upd = { ...prev };
      if (next.below == null && next.above == null) delete upd[ref];
      else upd[ref] = next;
      AsyncStorage.setItem('tcgradar.targets', JSON.stringify(upd)).catch(() => {});
      return upd;
    });
    // permetti di ri-notificare dopo una modifica della soglia
    targetNotifiedRef.current.delete('below-' + ref);
    targetNotifiedRef.current.delete('above-' + ref);
  }, []);

  const addToPortfolio = useCallback((item, buyPrice, qty) => {
    const holding = {
      id: item.ref + '-' + Date.now(),
      ref: item.ref, name: item.name, game: item.game, image: item.image, serial: item.serial,
      buyPrice: Number(buyPrice) || 0, qty: Number(qty) || 1, ts: Date.now(),
    };
    setPortfolio(prev => {
      const next = [holding, ...prev];
      AsyncStorage.setItem('tcgradar.portfolio', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const removeFromPortfolio = useCallback((id) => {
    setPortfolio(prev => {
      const next = prev.filter(h => h.id !== id);
      AsyncStorage.setItem('tcgradar.portfolio', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const sellHolding = useCallback((id, sellPrice) => {
    const sp = Number(sellPrice);
    setPortfolio(prev => {
      const h = prev.find(x => x.id === id);
      if (h && !isNaN(sp)) {
        const sale = {
          id: 'sale-' + Date.now(),
          ref: h.ref, name: h.name, game: h.game, image: h.image, serial: h.serial,
          buyPrice: h.buyPrice, sellPrice: sp, qty: h.qty,
          realized: Math.round((sp - h.buyPrice) * h.qty * 100) / 100,
          buyTs: h.ts, sellTs: Date.now(),
        };
        setSales(prevS => {
          const nextS = [sale, ...prevS];
          AsyncStorage.setItem('tcgradar.sales', JSON.stringify(nextS)).catch(() => {});
          return nextS;
        });
      }
      const next = prev.filter(x => x.id !== id);
      AsyncStorage.setItem('tcgradar.portfolio', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const removeSale = useCallback((id) => {
    setSales(prev => {
      const next = prev.filter(s => s.id !== id);
      AsyncStorage.setItem('tcgradar.sales', JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const exportData = useCallback(
    () => JSON.stringify({ v: 1, ts: Date.now(), portfolio, sales, saved, seen, targets }),
    [portfolio, sales, saved, seen, targets]
  );
  const importData = useCallback((text) => {
    let d;
    try { d = JSON.parse(text); } catch { return false; }
    if (!d || typeof d !== 'object') return false;
    const apply = (key, val, setter) => {
      if (val !== undefined) { setter(val); AsyncStorage.setItem(key, JSON.stringify(val)).catch(() => {}); }
    };
    apply('tcgradar.portfolio', d.portfolio, setPortfolio);
    apply('tcgradar.sales', d.sales, setSales);
    apply('tcgradar.saved', d.saved, setSaved);
    apply('tcgradar.seen', d.seen, setSeen);
    apply('tcgradar.targets', d.targets, setTargets);
    return true;
  }, []);

  const onToggleNotif = useCallback(async () => {
    if (!canNotify()) return;
    if (notifOn) {
      setNotifOn(false);
      AsyncStorage.setItem('tcgradar.notif', '0').catch(() => {});
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch {} }
    if (perm === 'granted') {
      setNotifOn(true);
      AsyncStorage.setItem('tcgradar.notif', '1').catch(() => {});
      try { new Notification('TCG Radar', { body: 'Notifiche attive: ti avviso quando una carta della watchlist si muove.', icon: '/icon.png' }); } catch {}
    }
  }, [notifOn]);

  const toggleSave = useCallback((item) => {
    setSaved(prev => {
      const exists = prev.some(s => s.ref === item.ref);
      const next = exists ? prev.filter(s => s.ref !== item.ref) : [item, ...prev];
      AsyncStorage.setItem('tcgradar.saved', JSON.stringify(next)).catch(() => {});
      return next;
    });
    // quando aggiungo una carta, registro il prezzo attuale per non dare un falso avviso
    if (!saved.some(s => s.ref === item.ref)) {
      const p = toEur(item.prices);
      if (p != null) {
        setSeen(prev => {
          const next = { ...prev, [item.ref]: p };
          AsyncStorage.setItem('tcgradar.seen', JSON.stringify(next)).catch(() => {});
          return next;
        });
      }
    }
  }, [saved]);

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
    setLastChecked(Date.now());
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-aggiornamento mentre l'app è aperta (ogni 5 min) e al rientro sull'app.
  useEffect(() => {
    const id = setInterval(() => { load(); }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Torna indietro dal dettaglio con lo swipe/gesto del telefono (o tasto hardware).
  // Sul web integriamo la cronologia: il gesto "scorri indietro" del browser chiude il dettaglio.
  useEffect(() => {
    if (!detail) return;
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.history) {
      window.history.pushState({ tcgDetail: true }, '');
      const onPop = () => setDetail(null);
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setDetail(null); return true; });
    return () => sub.remove();
  }, [detail]);

  const closeDetail = useCallback(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.history
      && window.history.state && window.history.state.tcgDetail) {
      window.history.back(); // fa scattare popstate -> chiude il dettaglio
    } else {
      setDetail(null);
    }
  }, []);

  // Carte salvate arricchite coi dati live + variazione "dall'ultima visita".
  const savedLive = useMemo(() => {
    const liveByRef = {};
    (data && data.items ? data.items : []).forEach(i => { liveByRef[i.ref] = i; });
    return saved.map(s => {
      const live = liveByRef[s.ref];
      const merged = live
        ? { ...s, prices: live.prices, change7d: live.change7d, tf: live.tf, chart: live.chart, history: live.history, image: live.image || s.image, inNews: live.inNews, bestOffer: live.bestOffer, buyLinks: live.buyLinks || s.buyLinks }
        : s;
      const cur = toEur(merged.prices);
      const base = seen[s.ref];
      merged.movedPct = (base && cur != null) ? Math.round(((cur - base) / base) * 1000) / 10 : null;
      return merged;
    });
  }, [saved, data, seen]);

  // Valore totale del portfolio ai prezzi live (fallback: prezzo d'acquisto).
  const pfTotal = useMemo(() => {
    const byRef = {};
    (data && data.items ? data.items : []).forEach(i => { byRef[i.ref] = i; });
    return portfolio.reduce((s, h) => {
      const live = byRef[h.ref];
      const cur = live ? toEur(live.prices) : null;
      return s + (cur != null ? cur : h.buyPrice) * h.qty;
    }, 0);
  }, [portfolio, data]);

  // Accumula lo storico del valore del portfolio: un punto al giorno (aggiorna l'ultimo se è di oggi).
  useEffect(() => {
    if (!data || !portfolio.length || pfTotal <= 0) return;
    const todayKey = new Date().toISOString().slice(0, 10);
    setPfHist(prev => {
      const val = Math.round(pfTotal * 100) / 100;
      const last = prev[prev.length - 1];
      const next = (last && String(last[0]).slice(0, 10) === todayKey)
        ? [...prev.slice(0, -1), [new Date().toISOString(), val]]
        : [...prev, [new Date().toISOString(), val]];
      const trimmed = next.slice(-400);
      AsyncStorage.setItem('tcgradar.pfhist', JSON.stringify(trimmed)).catch(() => {});
      return trimmed;
    });
  }, [data, portfolio, pfTotal]);

  // Notifiche: avvisa quando una carta della watchlist si muove (app aperta/in background).
  useEffect(() => {
    if (!notifOn || !canNotify() || Notification.permission !== 'granted' || !data) return;
    const fresh = savedLive.filter(c => {
      const moved = c.movedPct != null && Math.abs(c.movedPct) >= 5;
      const big = Math.abs(c.change7d) >= 10;
      return (moved || big) && !notifiedRef.current.has(c.ref);
    });
    if (!fresh.length) return;
    fresh.forEach(c => notifiedRef.current.add(c.ref));
    const names = fresh.slice(0, 3).map(c => c.name).join(', ');
    try {
      new Notification('TCG Radar — movimento', {
        body: `${fresh.length === 1 ? 'Si è mossa' : fresh.length + ' carte si sono mosse'}: ${names}`,
        icon: '/icon.png',
      });
    } catch {}
  }, [savedLive, notifOn, data]);

  // Soglie prezzo personali: notifica quando una carta scende sotto / sale sopra.
  useEffect(() => {
    if (!data || !data.items) return;
    const byRef = {};
    data.items.forEach(i => { byRef[i.ref] = i; });
    const canN = notifOn && canNotify() && Notification.permission === 'granted';
    Object.entries(targets).forEach(([ref, t]) => {
      const it = byRef[ref];
      if (!it) return;
      const cur = toEur(it.prices);
      if (cur == null) return;
      const checks = [
        { key: 'below-' + ref, hit: t.below != null && cur <= t.below, msg: `${it.name}: sceso a ${fmt(cur)} (soglia acquisto ${fmt(t.below)})` },
        { key: 'above-' + ref, hit: t.above != null && cur >= t.above, msg: `${it.name}: salito a ${fmt(cur)} (soglia vendita ${fmt(t.above)})` },
      ];
      checks.forEach(c => {
        if (c.hit) {
          if (canN && !targetNotifiedRef.current.has(c.key)) {
            targetNotifiedRef.current.add(c.key);
            try { new Notification('🎯 TCG Radar — soglia raggiunta', { body: c.msg, icon: '/icon.png' }); } catch {}
          }
        } else {
          targetNotifiedRef.current.delete(c.key);
        }
      });
    });
  }, [data, targets, notifOn]);

  // Digest giornaliero: una notifica al giorno (alla prima apertura) coi movimenti top.
  useEffect(() => {
    if (!notifOn || !canNotify() || Notification.permission !== 'granted' || !data || !data.items) return;
    const todayStr = new Date().toDateString();
    AsyncStorage.getItem('tcgradar.lastDigest').then(last => {
      if (last === todayStr) return;
      const top = [...data.items].sort((a, b) => b.change7d - a.change7d).slice(0, 3).filter(i => i.change7d >= 3);
      if (!top.length) return;
      const body = 'In salita oggi: ' + top.map(i => `${i.name} ${pct(i.change7d)}`).join(', ');
      try { new Notification('📊 TCG Radar — riepilogo del giorno', { body, icon: '/icon.png' }); } catch {}
      AsyncStorage.setItem('tcgradar.lastDigest', todayStr).catch(() => {});
    }).catch(() => {});
  }, [data, notifOn]);

  // Quando ESCO dalla watchlist, registro i prezzi attuali come "visti" (per il prossimo confronto).
  useEffect(() => {
    if (prevTab.current === 2 && tab !== 2 && data) {
      const next = { ...seen };
      savedLive.forEach(c => { const p = toEur(c.prices); if (p != null) next[c.ref] = p; });
      setSeen(next);
      AsyncStorage.setItem('tcgradar.seen', JSON.stringify(next)).catch(() => {});
    }
    prevTab.current = tab;
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

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
          onBack={closeDetail}
          isSaved={isSaved(detail.ref)}
          onToggleSave={toggleSave}
          onAddPortfolio={addToPortfolio}
          target={targets[detail.ref]}
          onSaveTarget={setTarget}
        />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={theme.bg} />

      <View style={styles.header}>
        <Text style={styles.logo}>⚓ TCG Radar</Text>
        <View style={styles.headerRight}>
          <View style={styles.pulse}>
            <Text style={styles.pulseLabel}>Mercato </Text>
            <Text style={[styles.pulseValue, { color: changeColor(data.marketPulse) }]}>
              {pct(data.marketPulse)}
            </Text>
          </View>
          <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh} disabled={refreshing} activeOpacity={0.6}>
            {refreshing ? <ActivityIndicator size="small" color={theme.accent} /> : <Ionicons name="refresh" size={20} color={theme.accent} />}
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.content}>
        {tab === 0 && <HomeTab data={data} rotation={rotation} onPress={setDetail} refreshing={refreshing} onRefresh={onRefresh} />}
        {tab === 1 && <PortfolioTab holdings={portfolio} sales={sales} pfHist={pfHist} data={data} onPress={setDetail} onRemove={removeFromPortfolio} onSell={sellHolding} onRemoveSale={removeSale} onExport={exportData} onImport={importData} refreshing={refreshing} onRefresh={onRefresh} />}
        {tab === 2 && <WatchlistTab data={savedLive} onPress={setDetail} refreshing={refreshing} onRefresh={onRefresh} notifOn={notifOn} onToggleNotif={onToggleNotif} />}
        {tab === 3 && <NewsTab news={data.news} lastUpdate={data.lastUpdate} lastChecked={lastChecked} refreshing={refreshing} onRefresh={onRefresh} />}
        {tab === 4 && <SearchTab onPress={setDetail} artists={data.artists} />}
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
  pulse: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border,
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5,
  },
  pulseLabel: { color: theme.textDim, fontSize: font.sm },
  pulseValue: { fontSize: font.sm, fontWeight: '800' },
  content: { flex: 1 },
  listLabel: { color: theme.textDim, fontSize: font.xs, fontWeight: '600', marginTop: 14, marginBottom: 2, marginLeft: 14, letterSpacing: 0.3 },

  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: theme.card, marginHorizontal: 12, marginTop: 10,
    borderRadius: 14, padding: 14, borderWidth: 1, borderColor: theme.border,
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
  movedPill: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  movedText: { fontSize: font.xs, fontWeight: '700' },
  watchBanner: { color: theme.text, fontSize: font.sm, fontWeight: '600', textAlign: 'center', paddingVertical: 12, paddingHorizontal: 16 },

  detail: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 16 },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 52, paddingBottom: 16 },
  backText: { color: theme.accent, fontSize: font.md },
  detailName: { color: theme.text, fontSize: font.xxl, fontWeight: '800' },
  detailSub: { color: theme.textDim, fontSize: font.sm, marginTop: 4 },
  detailImage: { width: 240, height: 336, alignSelf: 'center', marginTop: 16, marginBottom: 8 },
  iconicTag: { color: theme.accent, fontSize: font.sm, fontWeight: '700', marginTop: 6 },
  sectionTitle: { color: theme.textDim, fontSize: font.xs, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8, marginTop: 20 },

  priceBig: { backgroundColor: theme.card, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: theme.border },
  priceBigVal: { color: theme.accent, fontSize: font.xl, fontWeight: '800' },
  priceBigNote: { color: theme.textDim, fontSize: font.xs, marginTop: 4 },

  signalRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 4 },
  noteText: { color: theme.text, fontSize: font.sm, flex: 1, lineHeight: 20 },

  newsCard: {
    backgroundColor: theme.card, marginHorizontal: 12, marginTop: 10,
    borderRadius: 14, padding: 14, borderWidth: 1, borderColor: theme.border,
  },
  newsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  newsTag: { fontSize: font.sm },
  newsSource: { color: theme.textDim, fontSize: font.xs, flex: 1 },
  newsDate: { color: theme.textDim, fontSize: font.xs },
  newsTitle: { color: theme.text, fontSize: font.md, fontWeight: '700', marginBottom: 4 },
  newsOrig: { color: theme.textDim, fontSize: font.xs, fontStyle: 'italic', marginBottom: 6 },
  newsDir: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  newsDirText: { fontSize: font.xs, fontWeight: '600' },
  chipRow: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card },
  chipOn: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  chipTxt: { color: theme.textDim, fontSize: font.sm, fontWeight: '600' },
  chipTxtOn: { color: theme.text },

  thumb: { width: 54, height: 75, borderRadius: 5, marginRight: 12, backgroundColor: theme.bg },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border },

  buyRow: { flexDirection: 'row', gap: 8 },
  buy3: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    borderWidth: 1, borderColor: theme.accent, borderRadius: 10, paddingVertical: 12,
  },
  buy3Primary: { backgroundColor: theme.accent },
  buy3Text: { fontSize: font.sm, fontWeight: '700' },

  bestBox: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: theme.card, borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: theme.up,
  },
  bestPrice: { color: theme.up, fontSize: font.xl, fontWeight: '800' },
  bestSub: { color: theme.textDim, fontSize: font.xs, marginTop: 3 },
  bestBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: theme.up, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
  },
  bestBtnText: { color: theme.bg, fontSize: font.sm, fontWeight: '700' },
  marketGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  marketBtn: {
    width: '48%', flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: theme.border, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12,
    backgroundColor: theme.card,
  },
  marketBtnText: { color: theme.text, fontSize: font.sm, fontWeight: '600', flex: 1 },
  disclaimer: { color: theme.textDim, fontSize: font.xs, lineHeight: 16, marginTop: 12, fontStyle: 'italic' },
  notifBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: theme.accent, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7,
  },
  notifBtnOn: { backgroundColor: theme.accent },
  notifText: { fontSize: font.sm, fontWeight: '700' },

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
  suggThumb: { width: 40, height: 56, borderRadius: 4, backgroundColor: theme.bg },
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
  radarThumb: { width: 34, height: 47, borderRadius: 4, backgroundColor: theme.bg },
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

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  refreshBtn: { padding: 4, minWidth: 28, alignItems: 'center', justifyContent: 'center' },

  rampBox: {
    marginHorizontal: 12, marginTop: 12, padding: 12,
    backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.up,
  },
  rampTitle: { color: theme.up, fontSize: font.sm, fontWeight: '700', letterSpacing: 0.5 },
  rampReason: { color: theme.up, fontSize: font.xs, marginTop: 1 },

  portfolioBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: theme.accent, borderRadius: 10, paddingVertical: 13,
  },
  portfolioBtnText: { color: theme.bg, fontSize: font.md, fontWeight: '700' },
  portfolioDone: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  portfolioDoneText: { color: theme.up, fontSize: font.sm, fontWeight: '600', flex: 1 },
  buyForm: { backgroundColor: theme.card, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: theme.accent },
  buyFormLabel: { color: theme.textDim, fontSize: font.xs, marginBottom: 8 },
  buyFormRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  buyInput: {
    flex: 1, color: theme.text, fontSize: font.md, backgroundColor: theme.bg,
    borderWidth: 1, borderColor: theme.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9,
  },
  buyConfirm: { backgroundColor: theme.accent, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 11 },
  buyConfirmText: { color: theme.bg, fontSize: font.sm, fontWeight: '700' },

  pfSummary: { margin: 12, padding: 14, backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.accentDim },
  pfSumRow: { flexDirection: 'row', justifyContent: 'space-between' },
  pfSumLabel: { color: theme.textDim, fontSize: font.xs, marginBottom: 3 },
  pfSumVal: { color: theme.text, fontSize: font.md, fontWeight: '700' },
  pfRealized: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.border },
  allocBox: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    marginHorizontal: 12, marginTop: 10, padding: 14,
    backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
  },
  allocTitle: { color: theme.textDim, fontSize: font.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
  pfChartBox: { marginHorizontal: 12, marginTop: 10, padding: 14, backgroundColor: theme.card, borderRadius: 14, borderWidth: 1, borderColor: theme.border },
  allocRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  allocDot: { width: 12, height: 12, borderRadius: 6 },
  allocLabel: { color: theme.text, fontSize: font.sm, flex: 1 },
  allocPct: { color: theme.textDim, fontSize: font.sm, fontWeight: '600' },
  todayStrip: {
    marginHorizontal: 12, marginTop: 12, padding: 13,
    backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border,
    borderLeftWidth: 3, borderLeftColor: theme.accent,
  },
  todayMain: { color: theme.text, fontSize: font.md, fontWeight: '600' },
  todaySub: { color: theme.textDim, fontSize: font.sm, marginTop: 5 },
  sellForm: { backgroundColor: theme.card, borderRadius: 10, padding: 12, marginHorizontal: 12, marginTop: -4, borderWidth: 1, borderColor: theme.accent },
  backupBox: { marginHorizontal: 12, marginTop: 20, padding: 14, backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.border },
  backupHint: { color: theme.textDim, fontSize: font.xs, lineHeight: 17, marginTop: 2, marginBottom: 10 },
  backupInput: { color: theme.text, fontSize: font.sm, backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, minHeight: 70, textAlignVertical: 'top' },
  backupMsg: { color: theme.accent, fontSize: font.sm, marginTop: 10, fontWeight: '600' },
  pfRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: theme.card,
    marginHorizontal: 12, marginTop: 10, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: theme.border,
  },
  pfPl: { fontSize: font.md, fontWeight: '700' },
  pfHint: { fontSize: font.xs, fontWeight: '600', marginTop: 2 },
  srcChips: { flexDirection: 'row', gap: 8, marginTop: 10 },

  catTitle: { color: theme.textDim, fontSize: font.xs, fontWeight: '700', letterSpacing: 0.3, marginBottom: 8, textTransform: 'uppercase' },
  catSetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: theme.border,
  },
  catSetLogo: { width: 40, height: 26, borderRadius: 3, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' },
  catSetName: { color: theme.text, fontSize: font.md, fontWeight: '600', flex: 1 },
  catSetCount: { color: theme.textDim, fontSize: font.xs, marginRight: 4 },
  catBack: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, marginBottom: 4 },
  catBackText: { color: theme.accent, fontSize: font.md, fontWeight: '600' },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  catCard: { width: '31.5%', marginBottom: 12 },
  catThumb: { width: '100%', aspectRatio: 0.71, borderRadius: 5, backgroundColor: theme.bg },
  catCardName: { color: theme.text, fontSize: font.xs, marginTop: 4, fontWeight: '600' },
  catCardPrice: { color: theme.accent, fontSize: font.xs, fontWeight: '700', marginTop: 1 },
  sortLabel: { color: theme.textDim, fontSize: font.xs, alignSelf: 'center', marginRight: 2 },

  whyBox: { backgroundColor: theme.card, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: theme.accentDim },
  whyItem: { color: theme.text, fontSize: font.sm, lineHeight: 22 },
  whyNote: { color: theme.textDim, fontSize: font.xs, fontStyle: 'italic', marginTop: 8 },

  resaleBox: { backgroundColor: '#13351f', borderRadius: 10, padding: 14, marginTop: 12, borderWidth: 1, borderColor: theme.up },
  resaleTitle: { color: theme.up, fontSize: font.sm, fontWeight: '700' },
  resaleMain: { color: theme.text, fontSize: font.md, fontWeight: '700', marginTop: 6 },
  resaleUp: { color: theme.up, fontSize: font.lg, fontWeight: '800', marginTop: 2 },
  resaleNote: { color: theme.textDim, fontSize: font.xs, lineHeight: 16, marginTop: 8 },

  newsUpdated2: { color: theme.textDim, fontSize: font.xs, textAlign: 'center', paddingBottom: 4, fontStyle: 'italic' },

  illTag: { color: theme.hypeText, fontSize: font.sm, fontWeight: '600', marginTop: 4 },
  rangeBox: { marginTop: 14 },
  rangeBar: { height: 8, borderRadius: 4, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, overflow: 'hidden' },
  rangeFill: { height: '100%', backgroundColor: theme.accent },
  rangeLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  rangeLbl: { color: theme.textDim, fontSize: font.xs },
  rangeNote: { color: theme.textDim, fontSize: font.xs, marginTop: 4, fontStyle: 'italic' },

  auctionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: theme.hypeText, borderRadius: 10, paddingVertical: 13, marginTop: 10,
  },
  auctionBtnHot: { backgroundColor: theme.up },
  auctionText: { color: theme.bg, fontSize: font.sm, fontWeight: '700' },
  soldBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card,
    borderRadius: 10, paddingVertical: 12, marginTop: 8,
  },
  soldText: { color: theme.text, fontSize: font.sm, fontWeight: '600' },
  gradeRow: { flexDirection: 'row', gap: 8 },
  gradeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: theme.accent, borderRadius: 10, paddingVertical: 12,
  },
  gradeBtnText: { color: theme.accent, fontSize: font.sm, fontWeight: '700' },

  targetBox: { backgroundColor: theme.card, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: theme.border, marginTop: 4 },
  targetLabel: { color: theme.textDim, fontSize: font.xs, marginBottom: 8 },
  targetStatus: { fontSize: font.sm, fontWeight: '600', marginTop: 8 },
  targetHint: { color: theme.textDim, fontSize: font.xs, fontStyle: 'italic', marginTop: 8 },

  artStat: { color: theme.accent, fontSize: font.sm, fontWeight: '600', marginTop: 2 },
  artIntro: { color: theme.textDim, fontSize: font.xs, lineHeight: 17, marginBottom: 10 },
  artRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: theme.border },
  artRank: { color: theme.accent, fontSize: font.lg, fontWeight: '800', width: 22, textAlign: 'center' },
  artName: { color: theme.text, fontSize: font.md, fontWeight: '700' },
  artSub: { color: theme.textDim, fontSize: font.xs, marginTop: 2, marginBottom: 5 },
  artBarBg: { height: 6, borderRadius: 3, backgroundColor: theme.bg, overflow: 'hidden' },
  artBarFill: { height: '100%', backgroundColor: theme.accent },
});
