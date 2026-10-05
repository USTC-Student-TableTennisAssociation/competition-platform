export const VENUE_OPTIONS = ["西区乒乓球馆", "东区乒乓球馆"] as const;

export type VenueOption = (typeof VENUE_OPTIONS)[number];

export function isVenueOption(value: string): value is VenueOption {
  return (VENUE_OPTIONS as readonly string[]).includes(value);
}

export function defaultVenue() {
  return VENUE_OPTIONS[0];
}

/** Single-venue records remain valid; multi-venue records use the same text field. */
export function parseMatchVenues(value: string): VenueOption[] | null {
  const venues = value.split("、").map((venue) => venue.trim());
  if (
    venues.length > VENUE_OPTIONS.length ||
    venues.some((venue) => !isVenueOption(venue)) ||
    new Set(venues).size !== venues.length
  ) {
    return null;
  }
  return VENUE_OPTIONS.filter((venue) => venues.includes(venue));
}

export function normalizeMatchLocation(value: string): string | null {
  return parseMatchVenues(value)?.join("、") ?? null;
}
