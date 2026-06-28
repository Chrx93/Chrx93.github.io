import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
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

export default function Chart({ series, height = 170 }) {
  const [period, setPeriod] = useState('1m');
  const [width, setWidth] = useState(320);

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

  return (
    <View>
      <View style={styles.head}>
        <Text style={styles.price}>{euro(last)}</Text>
        <View style={[styles.chgPill, { backgroundColor: up ? '#13351f' : '#3a1514' }]}>
          <Text style={[styles.chg, { color }]}>
            {up ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% · {sel.label}
          </Text>
        </View>
      </View>

      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
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
          <SvgText x={padX} y={padTop + 4} fill={theme.textDim} fontSize="9">{euro(max)}</SvgText>
          <SvgText x={padX} y={baseY} fill={theme.textDim} fontSize="9">{euro(min)}</SvgText>
          {/* area + linea */}
          <Path d={areaPath} fill={color} fillOpacity={0.12} />
          <Polyline points={linePts} fill="none" stroke={color}
            strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <Circle cx={lx} cy={ly} r={3.5} fill={color} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border, borderRadius: 10, marginVertical: 8 },
  emptyText: { color: theme.textDim, fontSize: font.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  price: { color: theme.text, fontSize: font.xl, fontWeight: '800' },
  chgPill: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  chg: { fontSize: font.sm, fontWeight: '700' },
  periods: { flexDirection: 'row', gap: 6, marginTop: 10, justifyContent: 'center' },
  pBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.border },
  pBtnActive: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  pTxt: { color: theme.textDim, fontSize: font.sm, fontWeight: '600' },
  pTxtActive: { color: theme.text },
});
