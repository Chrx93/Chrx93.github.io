import React from 'react';
import Svg, { Polyline, Line, Circle } from 'react-native-svg';

export default function Sparkline({ data = [], width = 80, height = 32, color = '#c9a84c', showDot = true }) {
  if (!data || data.length < 2) return null;

  const validData = data.filter(v => v != null && !isNaN(v));
  if (validData.length < 2) return null;

  const min = Math.min(...validData);
  const max = Math.max(...validData);
  const range = max - min || 1;

  const pad = 3;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const points = validData.map((v, i) => {
    const x = pad + (i / (validData.length - 1)) * w;
    const y = pad + h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(' ');

  const lastX = pad + w;
  const lastY = pad + h - ((validData[validData.length - 1] - min) / range) * h;

  return (
    <Svg width={width} height={height}>
      <Polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {showDot && (
        <Circle cx={lastX} cy={lastY} r={2.5} fill={color} />
      )}
    </Svg>
  );
}
