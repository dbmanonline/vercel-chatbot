/**
 * Grounding verifier unit tests.
 *
 * Verifies:
 *   - unavailable: no tool calls => status=unavailable
 *   - unavailable: all tool calls errored => status=unavailable
 *   - unverified: tool calls returned records but no sources
 *   - verified: every claim in answer appears in tool-result corpus
 *   - unverified: fabricated claim with real sources still REJECTED
 *   - extractClaims finds numbers, brands, emails, phones
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractClaims, verifyGrounding } from "../lib/mcp/grounding";

test("verifyGrounding: no tool calls => unavailable", () => {
  const r = verifyGrounding("anything", []);
  assert.equal(r.status, "unavailable");
  assert.equal(r.verified, false);
});

test("verifyGrounding: all tool calls errored => unavailable", () => {
  const r = verifyGrounding("anything", [
    { args: {}, result: { error: "boom" }, toolName: "search_records" },
    { args: {}, result: { isError: true }, toolName: "group_records" },
  ]);
  assert.equal(r.status, "unavailable");
  assert.equal(r.verified, false);
});

test("verifyGrounding: tool results have no sources => unverified", () => {
  const r = verifyGrounding("The total is 100", [
    {
      args: { metric: "sum" },
      result: { total: 100 },
      toolName: "aggregate_data",
    },
  ]);
  assert.equal(r.status, "unverified");
  assert.equal(r.verified, false);
});

test("verifyGrounding: every claim in answer appears in tool results => verified", () => {
  const r = verifyGrounding(
    "We found 3 records from TestBrand and AcmeCo. Top customer UCP12345 has 500 units.",
    [
      {
        args: {},
        result: {
          records: [
            { brand: "TestBrand", customer: "UCP12345", id: "r1", qty: 500 },
            { brand: "AcmeCo", customer: "UCP99", id: "r2", qty: 12 },
            { brand: "TestBrand", customer: "UCP200", id: "r3", qty: 50 },
          ],
          total: 3,
        },
        sources: ["r1", "r2", "r3"],
        toolName: "search_records",
      },
    ]
  );
  assert.equal(r.status, "verified", JSON.stringify(r, null, 2));
  assert.equal(r.verified, true);
});

test("verifyGrounding: fabricated brand in answer REJECTED even with real sources", () => {
  const r = verifyGrounding(
    "We have data from PhantomBrand with 999 records. TestBrand has 3 records.",
    [
      {
        args: {},
        result: {
          records: [
            { brand: "TestBrand", id: "r1", qty: 1 },
            { brand: "TestBrand", id: "r2", qty: 2 },
            { brand: "TestBrand", id: "r3", qty: 0 },
          ],
          total: 3,
        },
        sources: ["r1", "r2", "r3"],
        toolName: "search_records",
      },
    ]
  );
  // PhantomBrand and 999 are not in the tool results => REJECTED.
  assert.equal(r.status, "unverified");
  assert.equal(r.verified, false);
  assert.ok(
    r.issues.some((i) => /PhantomBrand|999/.test(i)),
    `expected issue mentioning ungrounded claim, got: ${JSON.stringify(r.issues)}`
  );
});

test("verifyGrounding: fabricated number REJECTED even when brand is real", () => {
  const r = verifyGrounding("TestBrand sold 999999 units.", [
    {
      args: {},
      result: {
        records: [{ brand: "TestBrand", id: "r1", qty: 100 }],
        total: 1,
      },
      sources: ["r1"],
      toolName: "search_records",
    },
  ]);
  assert.equal(r.status, "unverified");
  assert.equal(r.verified, false);
  assert.ok(
    r.issues.some((i) => /999999/.test(i)),
    `expected issue mentioning 999999, got: ${JSON.stringify(r.issues)}`
  );
});

test("verifyGrounding: empty answer => unverified even with sources", () => {
  // Empty final answer cannot be verified per requirement.
  // Sources existing is irrelevant when there's nothing to ground.
  const r = verifyGrounding("", [
    {
      args: {},
      result: { records: [{ id: "r1" }], total: 1 },
      sources: ["r1"],
      toolName: "search_records",
    },
  ]);
  assert.equal(r.status, "unverified");
  assert.equal(r.verified, false);
});

test("verifyGrounding: answer containing only stop-words => verified", () => {
  const r = verifyGrounding("We found records based on data.", [
    {
      args: {},
      result: { records: [{ id: "r1" }], total: 1 },
      sources: ["r1"],
      toolName: "search_records",
    },
  ]);
  assert.equal(r.status, "verified");
});

test("extractClaims: numbers >= 3 digits", () => {
  const claims = extractClaims(
    "Total 500 units, customer UCP12345 has 12 orders."
  );
  // "500" should be present (free-standing 3-digit number).
  assert.ok(claims.includes("500"), JSON.stringify(claims));
  // "UCP12345" is added as a single capitalized token; the embedded
  // digits are part of the claim, not a separate one. Just verify that
  // the UCP reference is captured so the verifier can match it
  // against the corpus (which has customer: "UCP12345").
  assert.ok(
    claims.some((c) => /UCP12345/.test(c)),
    JSON.stringify(claims)
  );
});

test("extractClaims: capitalized brand names", () => {
  const claims = extractClaims("TestBrand and AcmeCo are the top brands.");
  // "TestBrand" appears (multi-word candidate or single)
  assert.ok(
    claims.some((c) => c.includes("TestBrand")),
    JSON.stringify(claims)
  );
  assert.ok(
    claims.some((c) => c.includes("AcmeCo")),
    JSON.stringify(claims)
  );
});

test("extractClaims: phone digit groups", () => {
  const claims = extractAnswersSafe("Call +1 (555) 123-4567 today!");
  // Phone number regex extracts full number as single claim (10+ digits normalized).
  assert.ok(
    claims.some((c) => c === "15551234567"),
    `Expected "15551234567", got: ${JSON.stringify(claims)}`
  );
});

test("extractClaims: email addresses", () => {
  const claims = extractAnswersSafe(
    "Contact contact@viettelpost.com.vn or sales@abc-corp.com"
  );
  assert.ok(
    claims.some((c) => c === "contact@viettelpost.com.vn"),
    `Expected "contact@viettelpost.com.vn", got: ${JSON.stringify(claims)}`
  );
  assert.ok(
    claims.some((c) => c === "sales@abc-corp.com"),
    `Expected "sales@abc-corp.com", got: ${JSON.stringify(claims)}`
  );
});

test("extractClaims: phone with various formats", () => {
  // Standard Vietnamese mobile: 09x xxx xxxx
  const claims1 = extractAnswersSafe("Gọi 0912 345 678 nhé");
  assert.ok(
    claims1.some((c) => c === "0912345678"),
    `Expected "0912345678", got: ${JSON.stringify(claims1)}`
  );
  // Landline with area code: (028) 1234 5678
  const claims2 = extractAnswersSafe("Hotline: (028) 1234 5678");
  assert.ok(
    claims2.some((c) => c === "02812345678"),
    `Expected "02812345678", got: ${JSON.stringify(claims2)}`
  );
});

test("extractClaims: email — no false positives on similar strings", () => {
  // Ensure things that look like emails but aren't don't get matched
  const claims = extractAnswersSafe("user_name@domain is not an email");
  assert.ok(
    !claims.some((c) => c.includes("@")),
    `Should not match "user_name@domain" as email: ${JSON.stringify(claims)}`
  );
});

test("verifyGrounding: empty answer returns unverified", () => {
  const check = verifyGrounding("", []);
  assert.equal(check.status, "unverified");
  assert.equal(check.verified, false);
  assert.ok(check.issues.some((i) => i.includes("empty")), JSON.stringify(check.issues));
});

test("verifyGrounding: whitespace-only answer returns unverified", () => {
  const check = verifyGrounding("   \n\t  ", []);
  assert.equal(check.status, "unverified");
  assert.equal(check.verified, false);
});

test("verifyGrounding: null answer returns unverified", () => {
  const check = verifyGrounding(null as any, []);
  assert.equal(check.status, "unverified");
  assert.equal(check.verified, false);
});

// helper to keep test imports tidy
function extractAnswersSafe(text: string): string[] {
  return extractClaims(text);
}
