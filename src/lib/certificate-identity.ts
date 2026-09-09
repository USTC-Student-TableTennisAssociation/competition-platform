import { randomBytes } from "node:crypto";

import { hashPassword, verifyPassword } from "./password";

export function normalizeIdentityInput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function hashIdentityValue(value: string) {
  return hashPassword(value);
}

export function verifyIdentityValue(value: string, storedHash: string) {
  return verifyPassword(value, storedHash).ok;
}

function formatDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function generateCertificateNumber(now = new Date()) {
  const datePart = `${now.getFullYear()}${formatDatePart(now.getMonth() + 1)}${formatDatePart(now.getDate())}`;
  const randomPart = randomBytes(3).toString("hex").toUpperCase();
  return `PPC-${datePart}-${randomPart}`;
}
