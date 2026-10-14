import { VENUE_OPTIONS, type VenueOption } from "../../../lib/locations";

// Recognize exact older campus labels without interpreting arbitrary desk text.
const ALIASES = new Map<string, VenueOption>([
  ["西区乒乓球馆", "西区乒乓球馆"], ["西区", "西区乒乓球馆"], ["西区馆", "西区乒乓球馆"],
  ["东区乒乓球馆", "东区乒乓球馆"], ["东区", "东区乒乓球馆"], ["东区馆", "东区乒乓球馆"],
]);

export function readGroupVenueAssignment(labels: readonly string[]) {
  const venues = [...new Set(labels.flatMap(label => ALIASES.has(label) ? [ALIASES.get(label)!] : []))];
  return {
    venue: venues.length === 1 ? venues[0] : null,
    venues,
    conflicting: venues.length > 1,
    tableLabels: labels.filter(label => !ALIASES.has(label)),
  };
}

export function groupVenueOptions(): readonly VenueOption[] {
  return VENUE_OPTIONS;
}

export function isGroupVenueAssignmentValid(labels: readonly string[]) {
  const assignment = readGroupVenueAssignment(labels);
  return labels.length - assignment.tableLabels.length <= 1;
}
