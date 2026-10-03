/**
 * Unit tests for GMDSS zone resolution and bulletin sources (work
 * doc #9): position/track fixtures → zone arrays, boundary
 * straddling, antimeridian routes, roman numerals, GMDSS HTML `<pre>`
 * extraction, TGFTP URL construction and the fetch ladder ordering.
 *
 * @file zone-source.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");

const {
  extractGmdssPre,
  fetchZoneBulletins,
  gmdssBulletinUrl,
  navtexStation,
  parseUkhoWarnings,
  resolveZones,
  romanNumeral,
  parseRnwDateTime,
  parseRnwHtml,
  tgftpUrl,
  ukhoWarningsUrl,
} = require("../plugin/zone-source.js");

test("parseUkhoWarnings: canonical keys, tolerant fallbacks, unknown payload", () => {
  const parsed = parseUkhoWarnings({
    warnings: [
      {
        text: "CHART DAMAGE",
        issuedAt: "2026-09-27T10:00:00Z",
        coordinates: [
          [-21.1, 175.2],
          [-21.5, 175.8],
          [-21.2, 176.1],
        ],
      },
      {
        message: "DRIFTING CONTAINER",
        created: "not-a-date",
        positions: [[10, 20]],
      },
      { text: "" },
      null,
    ],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, "CHART DAMAGE");
  assert.equal(parsed[0].issuedAt, "2026-09-27T10:00:00.000Z");
  assert.deepEqual(parsed[0].coordinates, [
    [175.2, -21.1],
    [175.8, -21.5],
    [176.1, -21.2],
  ]);
  assert.equal(parsed[1].text, "DRIFTING CONTAINER");
  assert.equal(parsed[1].issuedAt, null);
  assert.deepEqual(parsed[1].coordinates, [[20, 10]]);
  assert.deepEqual(parseUkhoWarnings({ nope: true }), []);
  assert.deepEqual(parseUkhoWarnings(null), []);
});

test("zone resolution: Tonga position resolves to XIV", () => {
  assert.deepEqual(resolveZones([[-175.2, -21.1]]), [14]);
  assert.deepEqual(resolveZones([[174.3, -35.3]]), [14]); // Opua, NZ
});

test("zone resolution: boundary crossing straddles X and XIV", () => {
  // The X/XIV boundary sits at 160E: a route from the Tasman into
  // Fijian waters legitimately activates both zones
  const zones = resolveZones([
    [155, -40],
    [165, -38],
  ]);
  assert.deepEqual(zones, [10, 14]);
});

test("zone resolution: antimeridian route stays in XIV", () => {
  const zones = resolveZones([
    [-179, -25],
    [179, -30],
  ]);
  assert.deepEqual(zones, [14]);
});

test("zone resolution: outside all bundled zones yields nothing", () => {
  // Arctic latitudes: the polar NAVAREAs are not in the bundled file
  assert.deepEqual(resolveZones([[0, 78]]), []);
  // London resolves to zone I (UK / North Atlantic, 48-75N)
  assert.deepEqual(resolveZones([[0, 51.5]]), [1]);
});

test("zone resolution: overlapping zones prefer the most specific", () => {
  // 20N 50E sits in both VIII (to 30N) and IX (12-30N); the smaller
  // polygon (IX, the Arabian Sea zone) wins for a single point
  assert.deepEqual(resolveZones([[50, 20]]), [9]);
});

// --- URLs & naming ----------------------------------------------------------

test("roman numerals and URL construction", () => {
  assert.equal(romanNumeral(14), "XIV");
  assert.equal(romanNumeral(10), "X");
  assert.equal(romanNumeral(4), "IV");
  assert.equal(romanNumeral(21), "XXI");
  assert.equal(gmdssBulletinUrl(14), "https://weather.gmdss.org/XIV.html");
  // The UKHO coordinates NAVAREA I only: zone 1 reads the RNW page,
  // other zones have no UKHO source at all (the old per-area JSON
  // API is gone and XIV 404s forever)
  assert.equal(
    ukhoWarningsUrl(1),
    "https://msi.admiralty.co.uk/RadioNavigationalWarnings",
  );
  assert.equal(ukhoWarningsUrl(14), null);
  assert.equal(ukhoWarningsUrl(10), null);
  assert.equal(
    tgftpUrl("fqps01", "NFFN"),
    "https://tgftp.nws.noaa.gov/data/raw/fq/fqps01.nffn..txt",
  );
  assert.equal(navtexStation(14), "Z"); // Wellington
  assert.equal(navtexStation(10), "O"); // Sydney
});

// --- GMDSS HTML extraction ------------------------------------------------------

test("extractGmdssPre pulls the bulletin body with entities decoded", () => {
  const html = `<!doctype html><html><head><title>XIV</title></head>
    <body><h1>NAVAREA XIV</h1>
    <pre>ZCZC GA14
011200Z AUG 26
GALE WARNING &amp; ROUGH SEAS
NNNN</pre>
    <footer>chrome</footer></body></html>`;
  const text = extractGmdssPre(html);
  assert.match(text, /^ZCZC GA14/);
  assert.match(text, /GALE WARNING & ROUGH SEAS\nNNNN$/);
  assert.equal(extractGmdssPre("<html><body>no pre</body></html>"), null);
});

// --- Fetch ladder ------------------------------------------------------------

function mockFetch(handlers) {
  return async (url) => {
    for (const [pattern, response] of Object.entries(handlers)) {
      if (String(url).includes(pattern)) {
        if (response instanceof Error) {
          throw response;
        }
        return response(url);
      }
    }
    throw new Error(`unexpected url ${url}`);
  };
}

test("fetch ladder: TGFTP preferred when configured, portal fallback", async () => {
  const calls = [];
  const tgftpResponse = (url) => {
    calls.push(`tgftp:${url}`);
    return {
      ok: true,
      text: async () => "FQPS01 NFFN 011200Z AUG 26\nGALE WARNING\nNNNN",
    };
  };

  // Station configured: TGFTP answers, portal never called
  let entries = await fetchZoneBulletins({
    zones: [14],
    tgftpStations: [{ zone: 14, header: "fqps01", station: "NFFN" }],
    fetchImpl: mockFetch({
      "tgftp.nws.noaa.gov": tgftpResponse,
      "weather.gmdss.org": (url) => {
        calls.push(`gmdss:${url}`);
        throw new Error("should not be called");
      },
    }),
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "api");
  assert.match(entries[0].text, /GALE WARNING/);
  assert.equal(
    calls.some((c) => c.startsWith("tgftp:")),
    true,
  );
  assert.equal(
    calls.some((c) => c.startsWith("gmdss:")),
    false,
  );

  // TGFTP down: the portal takes over
  calls.length = 0;
  entries = await fetchZoneBulletins({
    zones: [14],
    tgftpStations: [{ zone: 14, header: "fqps01", station: "NFFN" }],
    fetchImpl: mockFetch({
      "tgftp.nws.noaa.gov": new Error("connection refused"),
      "weather.gmdss.org": (url) => {
        calls.push(`gmdss:${url}`);
        return {
          ok: true,
          text: async () =>
            "<html><pre>ZCZC GA14 011200Z AUG 26 NAVAREA XIV 114/26 GALE WARNING</pre></html>",
        };
      },
    }),
  });
  assert.equal(entries.length, 1);
  assert.match(entries[0].text, /GALE WARNING/);
  assert.equal(
    calls.some((c) => c.startsWith("gmdss:")),
    true,
  );
});

test("fetch ladder: only resolved zones are fetched", async () => {
  const fetched = [];
  await fetchZoneBulletins({
    zones: [10, 14],
    fetchImpl: mockFetch({
      "weather.gmdss.org": (url) => {
        fetched.push(String(url));
        return {
          ok: true,
          text: async () => "<html><pre>SYNOPSIS</pre></html>",
        };
      },
    }),
  });
  // XIV and X fetched; the other nineteen zones untouched
  assert.equal(fetched.length, 2);
  assert.ok(fetched.some((u) => u.includes("XIV.html")));
  assert.ok(fetched.some((u) => u.includes("X.html")));
});

// --- UKHO Radio Navigational Warnings page --------------------------------

const readFixture = (name) =>
  require("node:fs").readFileSync(join(__dirname, "fixtures", name), "utf8");

test("parseRnwDateTime reads the RNW date-time group", () => {
  assert.equal(
    parseRnwDateTime("021011 UTC Oct 26"),
    "2026-10-02T10:11:00.000Z",
  );
  // 4-digit years and full month names tolerated
  assert.equal(
    parseRnwDateTime("010230 UTC Jan 2027"),
    "2027-01-01T02:30:00.000Z",
  );
  assert.equal(parseRnwDateTime("not a dtg"), null);
  assert.equal(parseRnwDateTime(null), null);
});

test("parseRnwHtml extracts reference, DTG and full text from the live page shape", () => {
  const warnings = parseRnwHtml(readFixture("ukho-rnw-sample.html"));
  assert.ok(warnings.length >= 2, "multiple warnings parsed");
  const first = warnings[0];
  // Reference and DTG prepend the console text, so the block reads
  // like a bulletin; the raw ANMB text follows
  assert.match(
    first.text,
    /^NAVAREA I 220\/26\n021011 UTC Oct 26\n\n1\. NAVAREA I/,
  );
  assert.equal(first.issuedAt, "2026-10-02T10:11:00.000Z");
  // Entity-encoded newlines (&#xA;) decoded into real paragraphs
  assert.ok(first.text.includes("\n\n2026 SERIES"));
  // Same shape the parseUkhoWarnings pipeline consumes: text,
  // issuedAt, coordinates (empty — the text pipeline filters)
  assert.deepEqual(first.coordinates, []);
  assert.ok(
    warnings.every((w) => typeof w.text === "string" && w.text.length > 0),
  );
  // Chrome without warning sections parses to nothing
  assert.deepEqual(parseRnwHtml("<html><body>cookie banner</body></html>"), []);
  assert.deepEqual(parseRnwHtml(""), []);
});
