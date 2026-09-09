export const V2_COMPETITION_TIME_ZONE = "Asia/Shanghai";

// Date#getTimezoneOffset uses UTC - local time. China Standard Time is UTC+8.
export const V2_COMPETITION_TIMEZONE_OFFSET_MINUTES = -8 * 60;

function asValidInstant(value: string | Date) {
  const instant = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("V2 competition date-time is invalid.");
  }
  return instant;
}

export function getV2CompetitionLocalDateTimeParts(value: string | Date) {
  const instant = asValidInstant(value);
  const local = new Date(
    instant.getTime() - V2_COMPETITION_TIMEZONE_OFFSET_MINUTES * 60 * 1_000,
  );
  const pad = (part: number) => String(part).padStart(2, "0");
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
  };
}

export function formatV2CompetitionDateTime(value: string | Date) {
  const { date, time } = getV2CompetitionLocalDateTimeParts(value);
  return `${date.replaceAll("-", "/")} ${time}`;
}
