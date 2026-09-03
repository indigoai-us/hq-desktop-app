<script lang="ts">
  /**
   * Trusted renderer for structured agent message content (stat / table /
   * chart / markdown blocks). See richMessageContent.ts for the security model:
   * blocks carry DATA, never markup. Every value here is bound through Svelte
   * text interpolation (auto-escaped) or a numeric SVG attribute — there is no
   * `{@html}` path for agent-supplied stat/table/chart data. The one markdown
   * block is routed through the existing CSP-safe message renderer.
   *
   * Desktop-alt design system: 13px body, hairline borders (--line), muted
   * labels (--t2/--t3), a single violet accent (--vio-ink). Scoped to
   * `.chat-shell` tokens so it inherits light + dark for free.
   */
  import { renderMessageBodyMarkdown } from "../../common/messageMarkdown.js";
  import type {
    ChartBlock,
    RichContentModel,
    StatItem,
    TableBlock,
  } from "./richMessageContent.js";

  interface Props {
    content: RichContentModel;
  }

  let { content }: Props = $props();

  const TREND_CLASS: Record<NonNullable<StatItem["trend"]>, string> = {
    up: "trend-up",
    down: "trend-down",
    flat: "trend-flat",
  };

  // ── Chart geometry (pure, deterministic; no external chart library) ────────
  const CHART_W = 460;
  const CHART_H = 140;
  const PAD_X = 8;
  const PAD_Y = 10;
  // Muted, accessible series ramp drawn from the shell token family.
  const SERIES_COLORS = [
    "var(--vio-ink)",
    "var(--ice-ink)",
    "var(--ok-ink)",
    "var(--warn-ink)",
  ];

  function seriesColor(index: number): string {
    return SERIES_COLORS[index % SERIES_COLORS.length];
  }

  function chartBounds(chart: ChartBlock): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (const series of chart.series) {
      for (const value of series.data) {
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
    if (min === max) {
      // Flat series: pad so the line/bar is visible and centered.
      const pad = Math.abs(min) || 1;
      return { min: min - pad, max: max + pad };
    }
    // Bars read from a zero baseline when all values are non-negative.
    if (min > 0) min = 0;
    return { min, max };
  }

  function pointCount(chart: ChartBlock): number {
    return chart.series.reduce((n, s) => Math.max(n, s.data.length), 0);
  }

  function xAt(i: number, count: number): number {
    if (count <= 1) return CHART_W / 2;
    return PAD_X + (i * (CHART_W - 2 * PAD_X)) / (count - 1);
  }

  function yAt(value: number, min: number, max: number): number {
    const span = max - min || 1;
    return CHART_H - PAD_Y - ((value - min) / span) * (CHART_H - 2 * PAD_Y);
  }

  function linePath(series: number[], min: number, max: number, count: number): string {
    return series
      .map((value, i) => `${i === 0 ? "M" : "L"}${xAt(i, count).toFixed(1)},${yAt(value, min, max).toFixed(1)}`)
      .join(" ");
  }

  interface Bar {
    x: number;
    y: number;
    w: number;
    h: number;
    fill: string;
  }

  function bars(chart: ChartBlock, min: number, max: number): Bar[] {
    const count = pointCount(chart);
    if (count === 0) return [];
    const groupWidth = (CHART_W - 2 * PAD_X) / count;
    const seriesCount = chart.series.length;
    const barGap = 2;
    const barWidth = Math.max(1, (groupWidth * 0.7 - barGap * (seriesCount - 1)) / seriesCount);
    const zeroY = yAt(Math.max(min, 0), min, max);
    const out: Bar[] = [];
    chart.series.forEach((series, sIndex) => {
      series.data.forEach((value, i) => {
        const groupX = PAD_X + i * groupWidth + groupWidth * 0.15;
        const x = groupX + sIndex * (barWidth + barGap);
        const y = yAt(value, min, max);
        out.push({
          x,
          y: Math.min(y, zeroY),
          w: barWidth,
          h: Math.max(1, Math.abs(zeroY - y)),
          fill: seriesColor(sIndex),
        });
      });
    });
    return out;
  }

  function tableAlignStyle(table: TableBlock, col: number): string {
    const align = table.align?.[col] ?? "left";
    return `text-align:${align}`;
  }
</script>

<div class="rich-content" data-testid="rich-message-content">
  {#each content.blocks as block, blockIndex (blockIndex)}
    {#if block.kind === "stat"}
      <div class="rich-stat-row" data-testid="rich-stat">
        {#each block.items as item, i (i)}
          <div class="rich-stat-tile">
            <div class="rich-stat-label">{item.label}</div>
            <div class="rich-stat-value">{item.value}</div>
            {#if item.delta}
              <div class="rich-stat-delta {item.trend ? TREND_CLASS[item.trend] : ''}">
                {item.delta}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if block.kind === "table"}
      <div class="rich-table-wrap" data-testid="rich-table">
        <table class="rich-table">
          {#if block.columns.length > 0}
            <thead>
              <tr>
                {#each block.columns as col, c (c)}
                  <th scope="col" style={tableAlignStyle(block, c)}>{col}</th>
                {/each}
              </tr>
            </thead>
          {/if}
          <tbody>
            {#each block.rows as row, r (r)}
              <tr>
                {#each row as cell, c (c)}
                  <td style={tableAlignStyle(block, c)}>{cell}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        {#if block.caption}
          <div class="rich-caption">{block.caption}</div>
        {/if}
      </div>
    {:else if block.kind === "chart"}
      {@const bounds = chartBounds(block)}
      {@const count = pointCount(block)}
      <figure class="rich-chart" data-testid="rich-chart">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          role="img"
          aria-label={block.caption || `${block.chartType} chart`}
          preserveAspectRatio="none"
        >
          <line
            class="rich-chart-axis"
            x1={PAD_X}
            x2={CHART_W - PAD_X}
            y1={yAt(Math.max(bounds.min, 0), bounds.min, bounds.max)}
            y2={yAt(Math.max(bounds.min, 0), bounds.min, bounds.max)}
          />
          {#if block.chartType === "bar"}
            {#each bars(block, bounds.min, bounds.max) as bar, i (i)}
              <rect x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill={bar.fill} rx="1" />
            {/each}
          {:else}
            {#each block.series as series, s (s)}
              <path
                d={linePath(series.data, bounds.min, bounds.max, count)}
                fill="none"
                stroke={seriesColor(s)}
                stroke-width="1.5"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
            {/each}
          {/if}
        </svg>
        {#if block.series.length > 1 || block.series[0]?.name}
          <figcaption class="rich-chart-legend">
            {#each block.series as series, s (s)}
              {#if series.name}
                <span class="rich-legend-item">
                  <span class="rich-legend-swatch" style={`background:${seriesColor(s)}`}></span>
                  {series.name}
                </span>
              {/if}
            {/each}
          </figcaption>
        {/if}
        {#if block.caption}
          <div class="rich-caption">{block.caption}</div>
        {/if}
      </figure>
    {:else if block.kind === "markdown"}
      <div class="rich-markdown msg-body">
        <!-- Routed through the CSP-safe message renderer (no raw HTML, no
             scripts, validated hrefs). Same trust level as every message body. -->
        {@html renderMessageBodyMarkdown(block.text)}
      </div>
    {/if}
  {/each}
</div>

<style>
  .rich-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    margin-top: 4px;
    font-size: 13px;
    color: var(--t1, var(--pop-text));
  }

  /* ── Stat tiles ─────────────────────────────────────────────────────── */
  .rich-stat-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .rich-stat-tile {
    flex: 1 1 120px;
    min-width: 110px;
    padding: 9px 11px;
    border: 1px solid var(--line, var(--pop-border));
    border-radius: 8px;
    background: var(--raised, var(--pop-hover));
  }
  .rich-stat-label {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--t3, var(--pop-muted));
  }
  .rich-stat-value {
    margin-top: 3px;
    font-size: 19px;
    font-weight: 600;
    line-height: 1.15;
    color: var(--t1, var(--pop-text));
    font-variant-numeric: tabular-nums;
  }
  .rich-stat-delta {
    margin-top: 2px;
    font-size: 11px;
    font-weight: 500;
    color: var(--t2, var(--pop-muted));
    font-variant-numeric: tabular-nums;
  }
  .rich-stat-delta.trend-up {
    color: var(--ok-ink, #248a3d);
  }
  .rich-stat-delta.trend-down {
    color: var(--red, #d9414d);
  }
  .rich-stat-delta.trend-flat {
    color: var(--t2, var(--pop-muted));
  }

  /* ── Table ──────────────────────────────────────────────────────────── */
  .rich-table-wrap {
    overflow-x: auto;
    border: 1px solid var(--line, var(--pop-border));
    border-radius: 8px;
  }
  .rich-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .rich-table th,
  .rich-table td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--line, var(--pop-border));
    white-space: nowrap;
  }
  .rich-table thead th {
    font-weight: 500;
    color: var(--t2, var(--pop-muted));
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.02em;
    background: var(--raised, var(--pop-hover));
  }
  .rich-table tbody tr:last-child td {
    border-bottom: none;
  }
  .rich-table td {
    color: var(--t1, var(--pop-text));
    font-variant-numeric: tabular-nums;
  }

  /* ── Chart ──────────────────────────────────────────────────────────── */
  .rich-chart {
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--line, var(--pop-border));
    border-radius: 8px;
    background: var(--raised, var(--pop-hover));
  }
  .rich-chart svg {
    display: block;
    width: 100%;
    height: 140px;
  }
  .rich-chart-axis {
    stroke: var(--line2, var(--pop-border));
    stroke-width: 1;
  }
  .rich-chart-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 6px;
    font-size: 11px;
    color: var(--t2, var(--pop-muted));
  }
  .rich-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .rich-legend-swatch {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    display: inline-block;
  }

  .rich-caption {
    margin-top: 5px;
    font-size: 11px;
    color: var(--t3, var(--pop-muted));
  }

  .rich-markdown {
    font-size: 13px;
    line-height: 1.45;
  }
</style>
