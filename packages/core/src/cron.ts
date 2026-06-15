import { z } from "zod";

interface CronFieldSpec {
  min: number;
  max: number;
}

const CRON_FIELD_SPECS: CronFieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7  }, // day-of-week (0 and 7 both represent Sunday)
];

function isCronTokenValid(token: string, spec: CronFieldSpec): boolean {
  if (token === "*") return true;

  if (token.includes("/")) {
    const [base, stepStr, ...extra] = token.split("/");
    if (extra.length > 0) return false;
    const step = Number(stepStr);
    if (!Number.isInteger(step) || step < 1) return false;
    if (base !== "*") {
      const baseNum = Number(base);
      if (!Number.isInteger(baseNum) || baseNum < spec.min || baseNum > spec.max) return false;
    }
    return true;
  }

  if (token.includes("-")) {
    const [startStr, endStr, ...extra] = token.split("-");
    if (extra.length > 0) return false;
    const start = Number(startStr);
    const end = Number(endStr);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start < spec.min || start > spec.max) return false;
    if (end < spec.min || end > spec.max) return false;
    if (start > end) return false;
    return true;
  }

  const n = Number(token);
  return Number.isInteger(n) && n >= spec.min && n <= spec.max;
}

export function isValidCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  return fields.every((field, index) => {
    const spec = CRON_FIELD_SPECS[index];
    if (!spec) return false;
    const tokens = field.split(",");
    if (tokens.length === 0 || tokens.some((t) => t === "")) return false;
    return tokens.every((token) => isCronTokenValid(token, spec));
  });
}

export const cronExpressionSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidCronExpression, {
    message:
      "Invalid cron expression. Expected 5 space-separated fields: minute hour day-of-month month day-of-week. Example: '0 9 * * 1-5'",
  });
