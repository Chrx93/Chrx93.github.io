import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, PanResponder } from 'react-native';
import Svg, { Path, Polyline, Line, Circle, Text as SvgText } from 'react-native-svg';
import { theme, font } from './theme';

// Periodi disponibili (giorni). "Tutto" = 0 -> nessun taglio.
const PERIODS = [
  { key: '7g', label: '7G', days: 7 },
  { key: '1m', label: '1M', days: 30 },
  { key: '3m', label: '3M', days: 90 },
  { key: 'all', label: 'Tutto', days: 0 },
];

// Accetta sia [[iso, prezzo], ...] sia [prezzo, ...]
function normalize(series) {
  if (!Array.isArray(series)) return [];
  return series
    .map((p) => {
      if (Array.isArray(p)) {
        const t = p[0] ? Date.parse(p[0]) : null;
        return { t: isNaN(t) ? null : t, v: Number(p[1]) };
      }
      return { t: null, v: Number(p) };
    })
    .filter((p) => p.v != null && !isNaN(p.v));
}

const euro = (n) =>
  n == null ? '—' : n >= 100 ? `€${Math.round(n)}` : `€${n.toFixed(2)}`;

const dateLabel = (t) =>
  t ? new Date(t).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' }) : '';

export default function Chart({ series, height = 180, unit = '€' }) {
  // unit '%' per serie percentuali (es. polso del mercato), '€' per i prezzi
  const fmtVal = unit === '%'
    ? (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`)
    : euro;
  const [period, setPeriod] = useState('1m');
  const [width, setWidth] = useState(320);
  const [touchX, setTouchX] = useState(null); // posizione del dito sul grafico (px)

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => setTouchX(e.nativeEvent.locationX),
      onPanResponderMove: (e) => setTouchX(e.nativeEvent.locationX),
      onPanResponderRelease: () => setTouchX(null),
      onPanResponderTerminate: () => setTouchX(null),
    })
  ).current;

  const all = normalize(series);
  if (all.length < 2) {
    return (
      <View style={[styles.empty, { height }]}>
        <Text style={styles.emptyText}>Storico non ancora disponibile</Text>
      </View>
    );
  }

  const hasTs = all.some((p) => p.t != null);
  const sel = PERIODS.find((p) => p.key === period) || PERIODS[1];

  // Filtra per periodo (se ci sono timestamp), altrimenti mostra tutto.
  let pts = all;
  if (hasTs && sel.days > 0) {
    const lastT = all[all.length - 1].t || Date.now();
    const cutoff = lastT - sel.days * 86400000;
    const f = all.filter((p) => p.t == null || p.t >= cutoff);
    if (f.length >= 2) pts = f;
  }

  const vals = pts.map((p) => p.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || Math.abs(max) || 1;

  const padX = 8;
  const padTop = 10;
  const padBottom = 16;
  const w = Math.max(width, 120);
  const innerW = w - padX * 2;
  const innerH = height - padTop - padBottom;

  const xy = pts.map((p, i) => {
    const x = padX + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
    const y = padTop + innerH - ((p.v - min) / range) * innerH;
    return [x, y];
  });

  const linePts = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const baseY = padTop + innerH;
  const areaPath =
    `M ${xy[0][0].toFixed(1)} ${baseY} ` +
    xy.map(([x, y]) => `L ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') +
    ` L ${xy[xy.length - 1][0].toFixed(1)} ${baseY} Z`;

  const first = vals[0];
  const last = vals[vals.length - 1];
  const change = first ? ((last - first) / first) * 100 : 0;
  const up = change >= 0;
  const color = up ? theme.up : theme.down;
  const [lx, ly] = xy[xy.length - 1];

  // Punto attivo sotto al dito (crosshair stile borsa)
  let activeIdx = null;
  if (touchX != null) {
    const frac = (touchX - padX) / innerW;
    activeIdx = Math.max(0, Math.min(pts.length - 1, Math.round(frac * (pts.length - 1))));
  }
  const dispIdx = activeIdx != null ? activeIdx : pts.length - 1;
  const dispVal = pts[dispIdx].v;
  const dispT = pts[dispIdx].t;

  return (
    <View>
      <View style={styles.head}>
        <Text style={styles.price}>{fmtVal(dispVal)}</Text>
        {activeIdx != null ? (
          <View style={[styles.chgPill, { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1 }]}>
            <Text style={[styles.chg, { color: theme.textDim }]}>{dispT ? dateLabel(dispT) : `punto ${dispIdx + 1}`}</Text>
          </View>
        ) : (
          <View style={[styles.chgPill, { backgroundColor: up ? '#13351f' : '#3a1514' }]}>
            <Text style={[styles.chg, { color }]}>{up ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% · {sel.label}</Text>
          </View>
        )}
      </View>

      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} {...pan.panHandlers}>
        <Svg width={w} height={height}>
          {/* griglia */}
          {[0, 0.5, 1].map((f) => {
            const y = padTop + innerH * f;
            return (
              <Line key={f} x1={padX} y1={y} x2={w - padX} y2={y}
                stroke={theme.border} strokeWidth={0.5} strokeDasharray="3,4" />
            );
          })}
          {/* etichette min/max */}
          <SvgText x={padX} y={padTop + 4} fill={theme.textDim} fontSize="9">{fmtVal(max)}</SvgText>
          <SvgText x={padX} y={baseY} fill={theme.textDim} fontSize="9">{fmtVal(min)}</SvgText>
          {/* area + linea */}
          <Path d={areaPath} fill={color} fillOpacity={0.14} />
          <Polyline points={linePts} fill="none" stroke={color}
            strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
          {/* crosshair stile borsa */}
          {activeIdx != null ? (
            <>
              <Line x1={xy[activeIdx][0]} y1={padTop} x2={xy[activeIdx][0]} y2={baseY}
                stroke={theme.text} strokeWidth={1} strokeDasharray="2,3" opacity={0.6} />
              <Circle cx={xy[activeIdx][0]} cy={xy[activeIdx][1]} r={5.5} fill={color} stroke={theme.bg} strokeWidth={2} />
            </>
          ) : (
            <Circle cx={lx} cy={ly} r={3.5} fill={color} />
          )}
        </Svg>
      </View>

      <View style={styles.periods}>
        {PERIODS.map((p) => {
          const active = p.key === period;
          return (
            <TouchableOpacity key={p.key} style={[styles.pBtn, active && styles.pBtnActive]}
              onPress={() => setPeriod(p.key)} activeOpacity={0.7}>
              <Text style={[styles.pTxt, active && styles.pTxtActive]}>{p.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.hint}>Scorri il dito sul grafico per vedere prezzo e data di ogni punto.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border, borderRadius: 12, marginVertical: 8 },
  emptyText: { color: theme.textDim, fontSize: font.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  price: { color: theme.text, fontSize: font.xl, fontWeight: '800' },
  chgPill: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4 },
  chg: { fontSize: font.sm, fontWeight: '700' },
  periods: { flexDirection: 'row', gap: 6, marginTop: 10, justifyContent: 'center' },
  pBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 9, borderWidth: 1, borderColor: theme.border },
  pBtnActive: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  pTxt: { color: theme.textDim, fontSize: font.sm, fontWeight: '600' },
  pTxtActive: { color: theme.text },
  hint: { color: theme.textDim, fontSize: font.xs, textAlign: 'center', marginTop: 8, fontStyle: 'italic' },
});
