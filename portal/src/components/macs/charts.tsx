"use client";

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@monashautomation/ui/chart";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";

/**
 * Charts for the portal, built on the shared chart primitives.
 *
 * Colour: series use the brand chart tokens in a fixed order (blue, then
 * amber: the pair that stays distinguishable for colour-blind readers in both
 * themes). A second series is also dashed, so it never relies on colour alone.
 * One y-axis per chart, always.
 */
const SERIES_COLOURS = ["var(--chart-1)", "var(--chart-3)"];

export interface Series {
  key: string;
  label: string;
}

const timeLabel = (span: "hour" | "day" | "week") => (t: number) => {
  const d = new Date(t);
  return span === "week"
    ? d.toLocaleDateString(undefined, { weekday: "short" })
    : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

/** A titled chart with its headline figure, which is also the text alternative. */
export function ChartFigure({
  title,
  summary,
  children,
}: {
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-semibold">{title}</span>
        {summary ? <span className="text-xs text-muted-foreground tabular-nums">{summary}</span> : null}
      </figcaption>
      {children}
    </figure>
  );
}

/** Change over time for one or two series that share a unit. */
export function TimeChart({
  data,
  series,
  unit,
  max,
  span,
}: {
  data: ({ time: number } & Record<string, number>)[];
  series: Series[];
  /** Appended to axis ticks and tooltip values, e.g. "%" or " GB". */
  unit: string;
  /** Top of the y-axis. Omit to fit the data. */
  max?: number;
  span: "hour" | "day" | "week";
}) {
  const config: ChartConfig = Object.fromEntries(
    series.map((s, i) => [s.key, { label: s.label, color: SERIES_COLOURS[i] }]),
  );
  const fmt = timeLabel(span);
  return (
    <ChartContainer config={config} className="aspect-auto h-40 w-full">
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="time"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={fmt}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={48}
        />
        <YAxis
          width={52}
          tickLine={false}
          axisLine={false}
          tickCount={4}
          domain={[0, max ?? "auto"]}
          tickFormatter={(v: number) => (unit.trim().length <= 2 ? `${v}${unit}` : String(v))}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) => {
                const t = (items?.[0]?.payload as { time?: number } | undefined)?.time;
                return t
                  ? new Date(t).toLocaleString(undefined, {
                      weekday: "short",
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : "";
              }}
              formatter={(value, name) => (
                <span className="flex w-full justify-between gap-4">
                  <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                  <span className="font-semibold tabular-nums">
                    {Number(value).toLocaleString()}
                    {unit}
                  </span>
                </span>
              )}
            />
          }
        />
        {series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
        {series.map((s, i) => (
          <Line
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            strokeDasharray={i > 0 ? "5 4" : undefined}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

/** GPU-hours booked per day against what the pool could supply. */
export function GpuHoursChart({
  days,
  capacity,
}: {
  days: { day: string; booked: number }[];
  capacity: number;
}) {
  const config: ChartConfig = { booked: { label: "GPU-hours booked", color: SERIES_COLOURS[0] } };
  const today = new Date().toDateString();
  const data = days.map((d) => ({
    ...d,
    label: new Date(d.day).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
  }));
  return (
    <ChartContainer config={config} className="aspect-auto h-40 w-full">
      <BarChart data={data} margin={{ top: 14, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="day"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={12}
          tickFormatter={(iso: string) => {
            const d = new Date(iso);
            return d.toDateString() === today
              ? "Today"
              : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
          }}
        />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          tickCount={4}
          domain={[0, capacity]}
          tickFormatter={(v: number) => `${v}h`}
        />
        <ReferenceLine
          y={capacity}
          stroke="var(--muted-foreground)"
          strokeDasharray="4 4"
          label={{
            value: `capacity ${capacity}h`,
            position: "insideTopRight",
            fill: "var(--muted-foreground)",
            fontSize: 11,
          }}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)" }}
          content={
            <ChartTooltipContent
              labelFormatter={(_, items) =>
                (items?.[0]?.payload as { label?: string } | undefined)?.label ?? ""
              }
              formatter={(value) => (
                <span className="font-semibold tabular-nums">
                  {Number(value)} of {capacity} GPU-hours booked
                </span>
              )}
            />
          }
        />
        <Bar
          dataKey="booked"
          fill="var(--color-booked)"
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  );
}

/** Ranked horizontal bars for a short list (who uses how much). Plain HTML: it is its own table. */
export function BarList({
  rows,
  unit,
}: {
  rows: { label: string; value: number; detail?: string }[];
  unit: string;
}) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="grid gap-2">
      {rows.map((r) => (
        <li
          key={r.label}
          className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm"
        >
          <span className="truncate" title={r.label}>
            {r.label}
          </span>
          <span className="h-2 rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary"
              style={{ width: `${(r.value / top) * 100}%` }}
            />
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {r.value} {unit}
            {r.detail ? ` · ${r.detail}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
