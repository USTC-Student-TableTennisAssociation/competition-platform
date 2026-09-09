import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { toV2CertificateSectionState } from "../read-model/single-certificate";

const routeSource = readFileSync(
  "src/app/api/matchs/[id]/certificate/route.ts",
  "utf8",
);
const evaluatorSource = readFileSync(
  "src/modules/competitions-v2/application/certificate-eligibility.ts",
  "utf8",
);
const issuerSource = readFileSync(
  "src/modules/competitions-v2/application/certificates.ts",
  "utf8",
);
const readModelSource = readFileSync(
  "src/modules/competitions-v2/read-model/single-certificate.ts",
  "utf8",
);

function position(source: string, text: string) {
  const index = source.indexOf(text);
  assert.notEqual(index, -1, `missing source marker: ${text}`);
  return index;
}

test("the certificate POST hard-dispatches V2 before the engine-guarded Legacy aggregate", () => {
  const discriminator = position(routeSource, "const matchDiscriminator =");
  const v2Branch = position(
    routeSource,
    'if (matchDiscriminator.engineVersion === "V2")',
  );
  const v2Issue = position(
    routeSource,
    "createV2CertificateApplicationService({ db: prisma }).issue",
  );
  assert.ok(discriminator < v2Branch && v2Branch < v2Issue);
  assert.match(routeSource, /status: 410/);
  assert.doesNotMatch(routeSource, /findOrCreateParticipationCertificate|engineVersion: "LEGACY"/);
  assert.match(routeSource, /V2CertificateApplicationError/);
});

test("the V2 reader exposes one six-cell section contract while retaining the old alias", () => {
  assert.match(readModelSource, /export async function getV2CertificateReadState/);
  assert.match(readModelSource, /export function toV2CertificateSectionState/);
  assert.match(
    readModelSource,
    /getV2SingleCertificateReadState = getV2CertificateReadState/,
  );

  const state = toV2CertificateSectionState(
    {
      kind: "CERTIFICATE_STATE",
      identityBound: false,
      existingCertificateNo: null,
      eligibility: {
        state: "INTEGRITY_ERROR",
        code: "CORRUPT_COMPETITION",
        entityId: "fixture-1",
        reason: "比赛数据损坏",
      },
    },
    "user@example.test",
  );
  assert.deepEqual(state, {
    currentUserEmail: "user@example.test",
    identityBound: false,
    existingCertificateNo: null,
    eligibility: { eligible: false, reason: "比赛数据损坏" },
  });
  assert.equal(
    toV2CertificateSectionState({ kind: "MATCH_NOT_FOUND" }, "user@example.test"),
    null,
  );
});

test("certificate authority is EntryMember/Fixture-only and never reads Legacy grouping payload", () => {
  const selectSource = issuerSource.slice(
    position(issuerSource, "const V2_CERTIFICATE_MATCH_SELECT"),
    position(issuerSource, "const V2_CERTIFICATE_DEPENDENCY_SELECT"),
  );
  assert.doesNotMatch(selectSource, /\bpayload:\s*true/);
  assert.doesNotMatch(selectSource, /sourceUserId:\s*true/);
  assert.match(selectSource, /members:\s*\{/);
  assert.match(selectSource, /lineupMembers:\s*\{/);
  assert.match(selectSource, /settlementEvents:\s*\{/);
  assert.match(evaluatorSource, /currentEntryIdByUserId/);
  assert.doesNotMatch(evaluatorSource, /sourceUserId/);
});

test("the issuer never catches P2002 inside its interactive transaction", () => {
  const transactionBody = issuerSource.slice(
    position(issuerSource, "async function issueInTransaction"),
    position(issuerSource, "export function createV2CertificateApplicationService"),
  );
  assert.doesNotMatch(transactionBody, /P2002/);
  assert.match(transactionBody, /createMany\(\{/);
  assert.match(transactionBody, /skipDuplicates:\s*true/);
  assert.match(transactionBody, /throw new FreshSnapshotRetry/);
});
