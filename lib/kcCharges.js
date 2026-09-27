// Merges a KC DAJD booking's two charge lists into one without duplicating
// charges: the DAJD portal's (offense text + offense code, bail, charge
// status, release code) and Socrata's (charge text, court, cause number,
// RCW/ordinance code, release reason).
//
// The two describe the same charge the same way -- the portal's offense
// "Assault - Investigation 1399" is Socrata's charge "Assault - Investigation"
// with rcw_ordinance_number "1399" -- so a charge is matched on normalized
// text + code. Matching is one-to-one in order, so a booking with the same
// charge twice pairs up twice rather than collapsing.
//
// Once the portal has charges for a booking, its list is the one displayed:
// Socrata only adds court/cause/RCW onto matching charges. A Socrata charge
// with no portal counterpart (e.g. one since amended -- 2026-012089: Socrata
// DWLS 2 + DUI vs portal DWLS 3 + Reckless Driving) is returned separately as
// `unmatchedSocrata`, kept on the record but not displayed. Until the portal
// has charges, Socrata's list is displayed as-is.

// "Malicious mischief - Investigation 5380" -> { text, code: '5380' }. The
// code is the last whitespace-separated token if it contains a digit.
export function splitOffense(offense) {
  const s = (offense || '').trim();
  const m = s.match(/^(.*\S)\s+(\S*\d\S*)$/);
  return m ? { text: m[1], code: m[2] } : { text: s, code: null };
}

// Letters and digits only, lowercased: our stored Socrata text has mojibake
// where the portal has punctuation (e.g. "bodily harm\uFFFDUnlawful" vs
// "bodily harm\u2014Unlawful", confirmed on 2026-012072), and code casing
// varies ("12a.14.080(B)"). The code still has to match, so this doesn't
// pair different charges -- just the same charge written two ways.
function normText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function chargeKey(text, code) {
  return `${normText(text)}|${normText(code)}`;
}

export function mergeCharges(portalCharges, socrataCharges) {
  const portal = portalCharges || [];
  const socrata = socrataCharges || [];
  if (portal.length === 0) {
    return { charges: socrata, unmatchedSocrata: [], stats: { portal: 0, socrata: socrata.length, matched: 0, unmatchedPortal: 0, unmatchedSocrata: 0 } };
  }
  const unused = socrata.map((c, i) => ({ c, i, key: chargeKey(c.charge, c.rcw) }));
  const merged = [];
  let matched = 0;

  for (const p of portal) {
    const key = chargeKey(p.charge, p.offenseCode);
    const idx = unused.findIndex(u => u.key === key);
    if (idx === -1) {
      merged.push(p);
      continue;
    }
    const s = unused.splice(idx, 1)[0].c;
    matched++;
    merged.push({
      ...p,
      court: s.court,
      causeNumber: s.causeNumber,
      rcw: s.rcw,
      releaseReason: s.releaseReason,
    });
  }

  return {
    charges: merged,
    unmatchedSocrata: unused.map(u => u.c),
    stats: { portal: portal.length, socrata: socrata.length, matched, unmatchedPortal: portal.length - matched, unmatchedSocrata: unused.length },
  };
}
