export const VENUE_OPTIONS = ["西区乒乓球馆", "东区乒乓球馆"] as const;

export type VenueOption = (typeof VENUE_OPTIONS)[number];

export function isVenueOption(value: string): value is VenueOption {
  return (VENUE_OPTIONS as readonly string[]).includes(value);
}

export function defaultVenue() {
  return VENUE_OPTIONS[0];
}
