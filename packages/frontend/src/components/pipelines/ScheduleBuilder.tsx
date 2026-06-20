/**
 * ScheduleBuilder — a low-code-friendly schedule picker.
 *
 * Provides preset buttons (every hour, daily, weekly, monthly), a custom
 * interval builder, a human-readable description of the resulting schedule,
 * and an "Advanced" toggle to edit the raw cron expression directly.
 *
 * The component is a controlled input: it receives `value` (a cron expression
 * string) and fires `onChange` with the new cron expression.
 */
import * as React from "react";
import { Clock, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Preset schedules
// ---------------------------------------------------------------------------

interface Preset {
  label: string;
  cron: string;
  description: string;
}

const PRESETS: Preset[] = [
  { label: "Every hour", cron: "0 * * * *", description: "Runs at the start of every hour" },
  { label: "Daily", cron: "0 9 * * *", description: "Runs every day at 9:00 AM" },
  { label: "Weekly", cron: "0 9 * * 1", description: "Runs every Monday at 9:00 AM" },
  { label: "Monthly", cron: "0 9 1 * *", description: "Runs on the 1st of every month at 9:00 AM" },
];

// ---------------------------------------------------------------------------
// Custom interval units
// ---------------------------------------------------------------------------

type IntervalUnit = "minutes" | "hours" | "days";

function intervalToCron(interval: number, unit: IntervalUnit): string {
  switch (unit) {
    case "minutes":
      if (interval <= 0 || interval > 59) return `*/${Math.max(1, Math.min(59, interval))} * * * *`;
      return `*/${interval} * * * *`;
    case "hours":
      if (interval <= 0 || interval > 23) return `0 */${Math.max(1, Math.min(23, interval))} * * *`;
      return `0 */${interval} * * *`;
    case "days":
      if (interval <= 0 || interval > 31) return `0 0 */${Math.max(1, Math.min(31, interval))} * *`;
      return `0 0 */${interval} * *`;
    default:
      return "0 * * * *";
  }
}

// ---------------------------------------------------------------------------
// Human-readable cron description
// ---------------------------------------------------------------------------

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "Invalid schedule";

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Exact presets
  if (cron === "0 * * * *") return "Runs at the start of every hour";
  if (cron === "* * * * *") return "Runs every minute";

  // Step patterns
  if (minute?.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const n = parseInt(minute.slice(2), 10);
    if (!isNaN(n)) return `Runs every ${n} minute${n === 1 ? "" : "s"}`;
  }
  if (minute === "0" && hour?.startsWith("*/") && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const n = parseInt(hour.slice(2), 10);
    if (!isNaN(n)) return `Runs every ${n} hour${n === 1 ? "" : "s"}`;
  }
  if (minute === "0" && hour === "0" && dayOfMonth?.startsWith("*/") && month === "*" && dayOfWeek === "*") {
    const n = parseInt(dayOfMonth.slice(2), 10);
    if (!isNaN(n)) return `Runs every ${n} day${n === 1 ? "" : "s"} at midnight`;
  }

  // Fixed time patterns
  if (dayOfMonth === "*" && month === "*") {
    const h = minute !== "*" && hour !== "*" ? `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}` : null;

    if (dayOfWeek === "*" && h) {
      return `Runs every day at ${h}`;
    }

    const dayNames: Record<string, string> = {
      "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday",
      "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday",
    };
    if (dayOfWeek !== undefined && dayOfWeek !== "*" && dayNames[dayOfWeek] && h) {
      return `Runs every ${dayNames[dayOfWeek]} at ${h}`;
    }
  }

  if (month === "*" && dayOfWeek === "*" && dayOfMonth !== "*" && minute !== "*" && hour !== "*") {
    const h = `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}`;
    // Standard English ordinal rules:
    //   - 11th, 12th, 13th are exceptions (teen numbers always use "th")
    //   - otherwise: 1→st, 2→nd, 3→rd, all others→th
    const n = parseInt(dayOfMonth ?? "", 10);
    const teenException = n >= 11 && n <= 13;
    const lastDigit = n % 10;
    const suffix = teenException
      ? "th"
      : lastDigit === 1
        ? "st"
        : lastDigit === 2
          ? "nd"
          : lastDigit === 3
            ? "rd"
            : "th";
    const ordinal = `${dayOfMonth}${suffix}`;
    return `Runs on the ${ordinal} of every month at ${h}`;
  }

  return `Custom schedule: ${cron}`;
}

// ---------------------------------------------------------------------------
// Detect which mode we are in from a cron string
// ---------------------------------------------------------------------------

function detectMode(cron: string): "preset" | "custom" | "advanced" {
  if (!cron.trim()) return "preset";
  for (const p of PRESETS) {
    if (p.cron === cron.trim()) return "preset";
  }
  // Check if it matches a simple interval pattern
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [m, h, d] = parts;
    if (m?.startsWith("*/") && h === "*" && d === "*") return "custom";
    if (m === "0" && h?.startsWith("*/") && d === "*") return "custom";
    if (m === "0" && h === "0" && d?.startsWith("*/")) return "custom";
  }
  return "advanced";
}

// ---------------------------------------------------------------------------
// ScheduleBuilder
// ---------------------------------------------------------------------------

export interface ScheduleBuilderProps {
  value: string;
  onChange: (cron: string) => void;
}

export function ScheduleBuilder({ value, onChange }: ScheduleBuilderProps) {
  const initialMode = React.useMemo(() => detectMode(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [mode, setMode] = React.useState<"preset" | "custom" | "advanced">(initialMode);
  const [customInterval, setCustomInterval] = React.useState(5);
  const [customUnit, setCustomUnit] = React.useState<IntervalUnit>("minutes");
  const [rawCron, setRawCron] = React.useState(value);

  // Sync rawCron when value changes externally
  React.useEffect(() => {
    setRawCron(value);
  }, [value]);

  const activePreset = PRESETS.find((p) => p.cron === value.trim());
  const description = value.trim() ? describeCron(value) : "No schedule set";

  return (
    <div className="space-y-3">
      <Label className="text-xs font-medium flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5" aria-hidden />
        Schedule
      </Label>

      {/* Human-readable description */}
      {value.trim() && (
        <div className="rounded-md bg-[var(--color-muted)] px-3 py-2">
          <p className="text-xs text-[var(--color-foreground)]">{description}</p>
          <p className="text-[10px] text-[var(--color-muted-foreground)] mt-0.5 font-mono">{value}</p>
        </div>
      )}

      {/* Preset buttons */}
      {mode !== "advanced" && (
        <div className="grid grid-cols-2 gap-1.5">
          {PRESETS.map((preset) => (
            <Button
              key={preset.cron}
              type="button"
              variant={activePreset?.cron === preset.cron ? "default" : "outline"}
              size="sm"
              className="h-8 text-xs justify-start"
              onClick={() => {
                setMode("preset");
                onChange(preset.cron);
              }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      )}

      {/* Custom interval builder */}
      {mode !== "advanced" && (
        <div className="space-y-2">
          <button
            type="button"
            className={cn(
              "text-[11px] font-medium",
              mode === "custom"
                ? "text-[var(--color-foreground)]"
                : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
            )}
            onClick={() => {
              setMode("custom");
              onChange(intervalToCron(customInterval, customUnit));
            }}
          >
            Custom interval
          </button>

          {mode === "custom" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-muted-foreground)] shrink-0">Every</span>
              <Input
                type="number"
                min={1}
                max={customUnit === "minutes" ? 59 : customUnit === "hours" ? 23 : 31}
                className="h-8 w-16 text-xs"
                value={customInterval}
                onChange={(e) => {
                  const n = Math.max(1, parseInt(e.target.value, 10) || 1);
                  setCustomInterval(n);
                  onChange(intervalToCron(n, customUnit));
                }}
              />
              <Select
                value={customUnit}
                onValueChange={(v) => {
                  const unit = v as IntervalUnit;
                  setCustomUnit(unit);
                  onChange(intervalToCron(customInterval, unit));
                }}
              >
                <SelectTrigger className="h-8 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">minutes</SelectItem>
                  <SelectItem value="hours">hours</SelectItem>
                  <SelectItem value="days">days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {/* Advanced raw cron toggle */}
      <div className="space-y-2">
        <button
          type="button"
          className="flex items-center gap-1 text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors"
          onClick={() => setMode(mode === "advanced" ? "preset" : "advanced")}
        >
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", mode === "advanced" && "rotate-180")}
            aria-hidden
          />
          {mode === "advanced" ? "Use visual builder" : "Advanced: Cron expression"}
        </button>

        {mode === "advanced" && (
          <div className="space-y-1.5">
            <Input
              id="cron-expression-raw"
              placeholder="e.g. 0 2 * * * (every day at 2am)"
              className="font-mono text-xs"
              value={rawCron}
              onChange={(e) => {
                setRawCron(e.target.value);
                onChange(e.target.value);
              }}
            />
            <p className="text-[10px] text-[var(--color-muted-foreground)]">
              Format: minute hour day-of-month month day-of-week
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
