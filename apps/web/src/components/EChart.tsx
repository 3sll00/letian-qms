import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

interface EChartsProps {
  option: echarts.EChartsOption;
  style?: React.CSSProperties;
  className?: string;
}

export function EChart({ option, style, className }: EChartsProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;

    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current, 'dark', {
        renderer: 'canvas',
      });
    }

    instanceRef.current.setOption(option, true);

    const handleResize = () => {
      instanceRef.current?.resize();
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [option]);

  useEffect(() => {
    return () => {
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, []);

  return (
    <div
      ref={chartRef}
      style={{ width: '100%', height: '320px', ...style }}
      className={className}
    />
  );
}
