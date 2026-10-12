import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { HeatmapChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
  AriaComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { RequestFlow } from '../../../../packages/contracts/src/index';
import { displayTimeZone, number } from '../components';
echarts.use([
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
  AriaComponent,
  CanvasRenderer,
]);
export default function LatencyHeatmap({
  data,
  onRange,
}: {
  data: RequestFlow;
  onRange: (from: number, to: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [table, setTable] = useState(false),
    zone = displayTimeZone();
  const label = (bin: number) =>
    bin === data.durationBounds.length
      ? '> 10초'
      : bin === 0
        ? '≤ 10ms'
        : `${data.durationBounds[bin - 1]}–${data.durationBounds[bin]}ms`;
  useEffect(() => {
    if (!ref.current || table || !data.histogram.length) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' }),
      first = Math.floor(data.from / data.stepMs) * data.stepMs;
    const full = Array.from(
      { length: Math.floor((data.to - first) / data.stepMs) + 1 },
      (_, i) => first + i * data.stepMs,
    );
    chart.setOption({
      animation: false,
      aria: {
        enabled: true,
        label: {
          description: '시간과 지연 구간별 관측 호출 수. 숫자 보기로 모든 값을 확인하세요.',
        },
      },
      grid: { left: 82, right: 15, top: 15, bottom: 55 },
      tooltip: {
        renderMode: 'richText',
        confine: true,
        formatter: (param: unknown) => {
          const p = param as { value: number[] };
          return `${new Date(full[p.value[0]]).toLocaleTimeString('ko-KR', { timeZone: zone })}\n${label(p.value[1])}: ${p.value[3]}건`;
        },
      },
      xAxis: {
        type: 'category',
        data: full.map((t) =>
          new Date(t).toLocaleTimeString('ko-KR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: zone,
          }),
        ),
        axisLabel: { interval: Math.max(0, Math.floor(full.length / 7)), color: '#64778b' },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'category',
        data: [...data.durationBounds.map((_, i) => label(i)), label(data.durationBounds.length)],
        axisLabel: { color: '#64778b', fontSize: 11 },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      visualMap: {
        show: true,
        min: 0,
        max: Math.max(1, ...data.histogram.map((h) => Math.log2(h.count + 1))),
        dimension: 2,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        text: ['많음', '적음'],
        inRange: { color: ['#e8f4f5', '#8fc7cc', '#287f91', '#183a63'] },
      },
      series: [
        {
          type: 'heatmap',
          data: data.histogram.map((h) => [
            full.indexOf(h.timestamp),
            h.bin,
            Math.log2(h.count + 1),
            h.count,
          ]),
          itemStyle: { borderWidth: 2, borderColor: '#ffffff' },
          emphasis: { itemStyle: { borderColor: '#315cc8', borderWidth: 2 } },
        },
      ],
    });
    chart.on('click', (param: unknown) => {
      const p = param as { value: number[] },
        start = full[p.value[0]];
      onRange(Math.max(data.from, start), Math.min(data.to, start + data.stepMs - 1));
    });
    const obs = new ResizeObserver(() => chart.resize());
    obs.observe(ref.current);
    return () => {
      obs.disconnect();
      chart.dispose();
    };
  }, [data, table, zone, onRange]);
  return (
    <section className="flow-heatmap">
      <div className="flow-section-head">
        <div>
          <h3>시간별 지연 분포</h3>
          <p>실제 관측 호출 수 · 셀을 선택하면 해당 시간 조사</p>
        </div>
        <button className="text-button" onClick={() => setTable(!table)}>
          {table ? '히트맵 보기' : '숫자 보기'}
        </button>
      </div>
      {!data.histogram.length ? (
        <div className="empty">분포를 계산할 관측 호출이 없습니다.</div>
      ) : table ? (
        <div className="table-scroll flow-hist-table">
          <table>
            <thead>
              <tr>
                <th>시간</th>
                <th>지연 구간</th>
                <th>관측 호출</th>
              </tr>
            </thead>
            <tbody>
              {data.histogram.map((h) => (
                <tr key={h.timestamp + ':' + h.bin}>
                  <td>{new Date(h.timestamp).toLocaleTimeString('ko-KR', { timeZone: zone })}</td>
                  <td>{label(h.bin)}</td>
                  <td>{number(h.count, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          ref={ref}
          style={{ height: 268 }}
          role="img"
          aria-label="시간별 지연 분포 히트맵, 숫자 보기 제공"
        />
      )}
    </section>
  );
}
