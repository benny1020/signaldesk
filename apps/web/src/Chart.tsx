import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, HeatmapChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  VisualMapComponent,
  AriaComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { Series } from '../../../packages/contracts/src/index';
echarts.use([
  LineChart,
  HeatmapChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  VisualMapComponent,
  AriaComponent,
  CanvasRenderer,
]);
const palette = ['#2869d8', '#087f8c', '#b16b31', '#a658a6'];
export default function Chart({
  series,
  title,
  height = 180,
  heatmap = false,
  onRange,
}: {
  series: Series[];
  title: string;
  height?: number;
  heatmap?: boolean;
  onRange?: (from: number, to: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    instance = useRef<ReturnType<typeof echarts.init> | null>(null),
    [table, setTable] = useState(false),
    [hidden, setHidden] = useState<string[]>([]);
  const visible = series.filter((s) => !hidden.includes(s.name));
  const hasData = series.some((s) => s.points.length > 0);
  useEffect(() => {
    if (!ref.current || table) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      instance.current = null;
    };
  }, [table, hasData]);
  useEffect(() => {
    const chart = instance.current;
    if (!chart) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const points = visible[0]?.points ?? [];
    const option: echarts.EChartsCoreOption = heatmap
      ? {
          animation: !reduced,
          aria: {
            enabled: true,
            label: { description: title + '. 시계열의 숫자는 데이터 보기에서 확인하세요.' },
          },
          grid: { left: 120, right: 20, top: 10, bottom: 50 },
          tooltip: {
            renderMode: 'richText',
            formatter: (p: unknown) => {
              const a = p as { value: number[] };
              return `${visible[a.value[1]]?.name}: ${a.value[2].toFixed(2)}`;
            },
          },
          xAxis: {
            type: 'category',
            data: points.map((p) =>
              new Date(p[0]).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
            ),
            axisLabel: { color: '#63758a', interval: Math.max(0, Math.floor(points.length / 8)) },
          },
          yAxis: {
            type: 'category',
            data: visible.map((s) => s.name),
            axisLabel: { color: '#63758a' },
          },
          visualMap: {
            min: 0,
            max: Math.max(1, ...visible.flatMap((s) => s.points.map((p) => p[1]))),
            calculable: true,
            orient: 'horizontal',
            left: 'center',
            bottom: 0,
            inRange: { color: ['#edf4fc', '#9bc5ed', '#2869d8', '#123451'] },
          },
          series: [
            {
              type: 'heatmap',
              data: visible.flatMap((s, y) => s.points.map((p, x) => [x, y, p[1]])),
            },
          ],
        }
      : {
          animation: !reduced,
          animationDuration: 150,
          aria: {
            enabled: true,
            label: { description: title + '. 시계열의 숫자는 데이터 보기에서 확인하세요.' },
          },
          grid: { left: 52, right: 14, top: 14, bottom: 38 },
          tooltip: {
            trigger: 'axis',
            renderMode: 'richText',
            confine: true,
            valueFormatter: (v: unknown) => `${Number(v).toFixed(2)} ${visible[0]?.unit ?? ''}`,
          },
          xAxis: {
            type: 'time',
            splitNumber: 5,
            axisLabel: {
              hideOverlap: true,
              color: '#748397',
              fontSize: 10,
              formatter: (v: number) =>
                new Date(v).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }),
            },
            axisLine: { lineStyle: { color: '#e0e7f0' } },
            axisTick: { show: false },
          },
          yAxis: {
            type: 'value',
            min: 0,
            axisLabel: { color: '#748397', fontSize: 10 },
            splitLine: { lineStyle: { color: '#edf1f6' } },
            name: visible[0]?.unit,
            nameTextStyle: { color: '#748397', fontSize: 10 },
            nameGap: 4,
          },
          dataZoom: [{ type: 'inside', filterMode: 'none', zoomOnMouseWheel: 'ctrl' }],
          series: visible.map((s) => ({
            name: s.name,
            type: 'line',
            data: s.points,
            showSymbol: false,
            smooth: false,
            sampling: 'lttb',
            connectNulls: false,
            lineStyle: {
              width: 2,
              color:
                palette[series.findIndex((original) => original.name === s.name) % palette.length],
            },
            itemStyle: {
              color:
                palette[series.findIndex((original) => original.name === s.name) % palette.length],
            },
            areaStyle:
              visible.length === 1
                ? {
                    color:
                      palette[
                        series.findIndex((original) => original.name === s.name) % palette.length
                      ],
                    opacity: 0.055,
                  }
                : undefined,
          })),
        };
    chart.setOption(option, { notMerge: false, replaceMerge: ['series'] });
    chart.off('datazoom');
    chart.on('datazoom', () => {
      if (!onRange || !points.length) return;
      const opt = chart.getOption() as { dataZoom?: { start: number; end: number }[] };
      const zoom = opt.dataZoom?.[0];
      if (zoom) {
        const first = points[0][0],
          last = points.at(-1)![0];
        onRange(
          Math.round(first + ((last - first) * zoom.start) / 100),
          Math.round(first + ((last - first) * zoom.end) / 100),
        );
      }
    });
  }, [visible, title, heatmap, onRange, table]);
  return (
    <div className="chart">
      <div className="chart-header">
        <h3>{title}</h3>
        <div className="chart-tools">
          {!heatmap && <span>Ctrl + 스크롤로 확대</span>}
          <button className="text-button" onClick={() => setTable(!table)}>
            {table ? '그래프 보기' : '데이터 보기'}
          </button>
        </div>
      </div>
      <div className="chart-legend">
        {series.map((s, i) => (
          <button
            key={s.name}
            aria-pressed={!hidden.includes(s.name)}
            onClick={() =>
              setHidden(
                hidden.includes(s.name) ? hidden.filter((n) => n !== s.name) : [...hidden, s.name],
              )
            }
          >
            <i
              style={{
                background: palette[i % palette.length],
                opacity: hidden.includes(s.name) ? 0.3 : 1,
              }}
            />
            {s.name}
          </button>
        ))}
      </div>
      {!hasData ? (
        <div className="empty chart-empty">선택한 범위에 수집 데이터가 없습니다.</div>
      ) : table ? (
        <div className="chart-table" key="numeric-table">
          <table>
            <thead>
              <tr>
                <th>시간</th>
                {series.map((s) => (
                  <th key={s.name}>
                    {s.name} ({s.unit})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...new Set(series.flatMap((s) => s.points.map(([t]) => t)))]
                .sort((a, b) => a - b)
                .map((t) => (
                  <tr key={t}>
                    <td>{new Date(t).toLocaleTimeString('ko-KR')}</td>
                    {series.map((s) => (
                      <td key={s.name}>
                        {s.points.find(([time]) => time === t)?.[1].toFixed(2) ?? '—'}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          key="chart-canvas"
          ref={ref}
          style={{ height }}
          role="img"
          aria-label={`${title}. ${series.map((s) => s.name + ': ' + s.points.length + '개 시점').join(', ')}. 숫자는 데이터 보기에서 확인할 수 있습니다.`}
        />
      )}
    </div>
  );
}
