// Stats helpers for the unlisted Deep Stats page.
// Charge category/severity are best-effort classifications from raw charge
// text (no structured charge-class field exists in any of the 4 sources).
//
// Cross-source rules (do not violate without re-reading these comments):
// - Stay length and bail must never be combined across sources -- each
//   source's release-time and bail semantics are different enough (see
//   below) that a blended average would be meaningless or misleading.
// - Stay length only ever uses releaseSource === 'county' (a real,
//   source-published release timestamp that parses as a valid date) --
//   'detected'/'unverified'/null entries have no trustworthy release time.
// - No individual's name appears anywhere in stats output.

import { SOURCES } from './sources'

function stripSuffix(charge) {
  return charge
    .replace(/\/(FTA|FTC|PV|FEL|FELONY)\b.*$/i, '')
    .replace(/\s*-\s*FELONY$/i, '')
    .trim()
}

const CATEGORY_RULES = [
  ['Sex Offense', /RAPE|MOLEST|INDECENT LIBERT|INDECENT EXPOS|VOYEUR|PORNOGRAP|SEXUAL EXPLOIT|INCEST|COMM W\/MINOR IMMORAL|SEX OFFEND|PROSTITUT|LURING/],
  ['Violent', /MURDER|HOMICIDE|ASSAULT|ROBBERY|KIDNAP|VEHICULAR ASSAULT|RECKLESS ENDANGERMENT|DRIVE-BY SHOOTING|UNLAWFUL IMPRISON|MALICIOUS HARASSMENT|CUSTODIAL ASSAULT|\bHARASSMENT\b|STALKING|BOMB THREAT|WITNESS TAMPER|INTIMIDATE WITNESS|THREATENING/],
  ['Weapons', /FIREARM|WEAPON|CARRY CONCEALED/],
  ['Drug', /CONT SUB|CONTROLL?ED SUBSTANCE|NARC|VUCSA|POCS|DRUG PARAPHERNALIA|MAINTAINING A HOUSE FOR DRUGS|POSESSION OF DRUGS|TOXIC SUBSTANCE|CONSUME ALCOHOL|INHALATION/],
  ['Traffic / DUI', /\bDUI\b|DWLS|RECKLESS DRIVING|HIT\/RUN|HIT AND RUN|PHYSICAL CONTROL|IGNITION INTER|NEGLIGENT DRIVING|NO VALID OPER LICENSE|OPERATE VEH|OPER VEH|FLIP LICENSE PLATE|ELUDE POLICE|ATTEMPTING ELUDE|TRANSFER TITLE|VAL CERT TITLE|VEH OPR-REFUSE COMPLY/],
  ['Order Violations', /VIOL.*PROT|VIOL.*ORDER|VIOL.*\bORD\b|NO CONTACT ORDER|ANTIHARASS|ANTI-HARASS|INTERFERE W\/REPORT OF DV/],
  ['Fraud / Identity', /IDENTITY THEFT|FORGERY|CRIMINAL IMPERSONATION|FINANCIAL FRAUD|FRUAD|MONEY LAUNDERING|EXTORTION|FALSE STATEMENT/],
  ['Property', /THEFT|BURGLARY|MAL MISCH|MALICIOUS MISCHIEF|SHOPLIFT|STOLEN PROP|STOLEN VEHICLE|STOLEN FIREARM|VEHICLE PROWL|TRE?SSPASS|TRESPASS|ARSON|RECKLESS BURNING|TRAFFICKING STOLEN|TAMPER/],
  ['Court / Supervision', /PROB\/PAROLE|PROBATION|PAROLE|DOC DETAINER|DOC WARRANT|BOND REVOCATION|DOSA REVOCATION|FUGITIVE FROM JUSTICE|DISOBEDIENCE OF LAWFUL ORDER|MATERIAL WITNESS/],
  ['Resisting/Obstructing Law Enforcement', /OBSTRUCT|RESISTING|FAIL TO OBEY POLICE/],
  ['Public Order', /DISORD|PUBLIC NUISANCE|URINATING IN PUBLIC|SITTING OR LYING ON PUBLIC|OBSTRUCTING PEDESTRIAN|VIOL.*(FDERAL|FEDERAL) OR STATE LAW/],
]

export function categorizeCharge(rawCharge) {
  const c = stripSuffix((rawCharge || '').toUpperCase())
  for (const [name, re] of CATEGORY_RULES) {
    if (re.test(c)) return name
  }
  return 'Other'
}

const SEVERITY_RULES = [
  // explicit felony/GM markers first
  [/\/FEL\b|FELONY/, 'Felony'],
  [/\/GM\b|GROSS MISD/, 'Gross Misdemeanor'],

  // named felonies (degree-independent)
  [/MURDER|KIDNAP|RAPE|CHILD MOLEST|INCEST|SEXUAL EXPLOITATION|PORNOGRAP|INDECENT LIBERT|ARSON 1ST|ROBBERY|BURGLARY|ATTEMPTING ELUDE|ELUDE POLICE|IDENTITY THEFT|TRAFFICKING STOLEN|POSSESSION OF STOLEN VEHICLE|THEFT OF MOTOR VEHICLE|UNLAWFUL POSS OF FIREARM|ILLEGAL POSS FIREARM|POSS STOLEN FIREARM|VEHICULAR ASSAULT|CUSTODIAL ASSAULT|WITNESS TAMPER|INTIMIDATE WITNESS|TAMPER WITH PHYSICAL EVIDENCE|CRIM CONSPIRACY|CRIMINAL ATTEMPT|MALICIOUS HARASSMENT|VOYEUR|LURING|FORGERY|MONEY LAUNDERING|FINANCIAL FRAUD|FRUAD|EXTORTION|ALTER ID MARK ON FIREARM|VIOL.*TWO PREV CONV|CRIMINAL IMPERSONATION|DUI - FELONY|CONT SUB-MFG|CONT SUB-DIST|CONT SUB-DISP|MFG\/DEL|MAN\/DEL\/POSS NARCOTIC|DELIVER CONTROLLED SUBSTANCE|MAINTAINING A HOUSE FOR DRUGS/, 'Felony'],

  // degree-numbered charges: 1st/2nd default felony, 3rd usually GM (assault 4th handled below)
  [/ASSAULT 1ST|ASSAULT 2ND|ASSAULT 3RD|ASSAULT AND BATTERY 2ND|ASSAULT BATTERY 3RD|THEFT 1ST|THEFT 2ND/, 'Felony'],
  [/ASSAULT 4TH|THEFT 3RD|SHOPLIFT|RETAIL THEFT|POSS STOLEN PROP 3RD|CRIMINAL TRESPASS 1ST|MAL MISCH 2ND|VEHICLE PROWL 2ND|RECKLESS DRIVING|RECKLESS ENDANGERMENT|RECKLESS BURNING|\bDUI\b|PHYSICAL CONTROL|DWLS 1ST|FAILURE TO REGISTER AS A SEX OFFENDER|SEX OFFEND REG|STALKING|HARASSMENT|VIOL.*PROT|VIOL.*ORDER|NO CONTACT ORDER|ANTIHARASS|ANTI-HARASS|INTERFERE W\/REPORT OF DV|CARRY\/EXHIBIT\/DRAW WEAPON|TAMPER W\/FIRE ALARM|IGNITION INTER|DISPLAY WEAPON/, 'Gross Misdemeanor'],
  [/CRIMINAL TRESPASS 2ND|TRESSPASS|DWLS 2ND|DWLS 3RD|OBSTRUCT|RESISTING|DISORDERLY COND|MAL MISCH 3RD|POSS DRUG PARAPHERNALIA|CARRY CONCEALED|POSS DANGEROUS WEAPON|FALSE STATEMENT TO OFFICER|FAIL TO OBEY POLICE OFFICER|HIT\/RUN UNATTENDED|MINOR POSS\/CONSUME ALCOHOL|NO VALID OPER LICENSE|NEGLIGENT DRIVING|URINATING IN PUBLIC|PUBLIC NUISANCE|OBSTRUCTING PEDESTRIAN|POSSESS TOXIC SUBSTANCE|UNLAWFUL INHALATION|FLIP LICENSE PLATE|OPERATE VEH W\/O VAL CERT TITLE|FAIL TO TRANSFER TITLE|INDECENT EXPOSURE/, 'Misdemeanor'],
  [/POSSESSION OF A CONTROLED SUBSTANCE|CONT SUB KNOWN POSS|CONT SUB-POSS NO PRESCRIPTION|POCS/, 'Gross Misdemeanor'],
]

export function classifySeverity(rawCharge) {
  const c = (rawCharge || '').toUpperCase()
  for (const [re, sev] of SEVERITY_RULES) {
    if (re.test(c)) return sev
  }
  return 'Unknown'
}

export function parseBail(bailStr) {
  if (!bailStr) return null
  const m = bailStr.replace(/,/g, '').match(/\$([\d.]+)/)
  if (!m) return null
  return parseFloat(m[1])
}

export function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function mean(nums) {
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export function daysBetween(startStr, endStr) {
  const start = new Date(startStr)
  const end = new Date(endStr)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null
  const days = (end - start) / (1000 * 60 * 60 * 24)
  return days >= 0 ? days : null
}

function topN(counter, n) {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }))
}

function groupBySource(log) {
  const bySource = {}
  for (const s of SOURCES) bySource[s.id] = []
  for (const e of log) {
    if (!bySource[e.source]) bySource[e.source] = []
    bySource[e.source].push(e)
  }
  return bySource
}

// Only entries with a real, source-published, validly-parsing release time
// are trustworthy for a duration calculation -- 'detected' (our own
// disappearance-based guess) and 'unverified' (Kirkland's own real-date
// column, not independently confirmed) are not.
function countyReleased(entries) {
  return entries.filter(e => e.status === 'released' && e.releaseSource === 'county')
}

function stayStatsFor(entries) {
  const stays = countyReleased(entries)
    .map(e => daysBetween(e.bookingDate || e.firstSeen, e.releasedAt))
    .filter(d => d !== null)
  return { n: stays.length, avgDays: mean(stays), medianDays: median(stays) }
}

// Kirkland's booking-detail page publishes one "Total Bond Amount" for the
// whole booking, and the scraper (scrapers/kirkland.js parseDetail) copies
// that same value onto every charge on the booking -- summing/averaging
// per-charge would count one bail figure 2-3x over on a multi-charge
// booking. SCORE and Kent both publish a genuine per-charge bail/bond
// amount, so those two are counted per charge. KC DAJD's feed has no
// bail/bond field at all (confirmed against its raw schema).
const BAIL_UNIT = { score: 'charge', kent: 'charge', kirkland: 'booking', kc_dajd: null }

function bailStatsFor(entries, unit) {
  if (!unit) return { unit: null, n: 0, median: null, mean: null, max: null, byCategory: [] }

  const values = []
  const byCategory = {}
  const pushCategorized = (amt, categories) => {
    values.push(amt)
    for (const cat of categories) {
      byCategory[cat] = byCategory[cat] || []
      byCategory[cat].push(amt)
    }
  }

  if (unit === 'booking') {
    for (const e of entries) {
      const charges = e.charges || []
      const amt = charges.map(c => parseBail(c.bail)).find(v => v > 0)
      if (!amt) continue
      const cats = new Set(charges.filter(c => c.charge).map(c => categorizeCharge(c.charge)))
      pushCategorized(amt, cats.size ? cats : ['Other'])
    }
  } else {
    for (const e of entries) {
      for (const c of e.charges || []) {
        const amt = parseBail(c.bail)
        if (!amt || amt <= 0) continue
        pushCategorized(amt, [categorizeCharge(c.charge)])
      }
    }
  }

  return {
    unit,
    n: values.length,
    median: median(values),
    mean: mean(values),
    max: values.length ? Math.max(...values) : null,
    byCategory: Object.entries(byCategory)
      .map(([category, vals]) => ({ category, median: median(vals), mean: mean(vals), n: vals.length }))
      .sort((a, b) => b.median - a.median),
  }
}

export function computeStats(log) {
  const bySource = groupBySource(log)
  const sourceIds = SOURCES.map(s => s.id)

  const totalBookings = log.length
  const inCustody = log.filter(e => e.status === 'in_custody')
  const released = log.filter(e => e.status === 'released')

  const allDates = log
    .map(e => new Date(e.bookingDate || e.firstSeen))
    .filter(d => !isNaN(d.getTime()))
  const dateRange = allDates.length
    ? { min: new Date(Math.min(...allDates)), max: new Date(Math.max(...allDates)) }
    : null

  // --- Summary ---
  const chargeCounts = log.map(e => (e.charges || []).length)
  const totals = {
    totalBookings,
    inCustody: inCustody.length,
    released: released.length,
    avgCharges: mean(chargeCounts),
    medianCharges: median(chargeCounts),
    maxCharges: chargeCounts.length ? Math.max(...chargeCounts) : 0,
    dateRange,
  }

  // --- Stay length (per source only -- never combined, see file header) ---
  const stayLength = sourceIds.map(id => ({ source: id, ...stayStatsFor(bySource[id]) }))

  // --- Trends (bookings by day of week) ---
  // Uses the actual bookingDate (real arrest timestamp), not firstSeen --
  // staleness doesn't matter here since only the weekday name is used, and
  // bookingDate reflects when people were actually arrested rather than
  // when our scraper noticed them.
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const weekdayCounts = new Array(7).fill(0)
  for (const e of log) {
    const d = new Date(e.bookingDate || e.firstSeen)
    if (!isNaN(d.getTime())) weekdayCounts[d.getDay()] += 1
  }
  const trends = { byWeekday: WEEKDAY_NAMES.map((name, i) => ({ name, count: weekdayCounts[i] })) }

  // --- Crime Types ---
  const categoryCounts = {}
  const severityCounts = {}
  const offenseCounts = {}
  for (const e of log) {
    const cats = new Set()
    for (const c of e.charges || []) {
      if (!c.charge) continue
      cats.add(categorizeCharge(c.charge))
      severityCounts[classifySeverity(c.charge)] = (severityCounts[classifySeverity(c.charge)] || 0) + 1
      offenseCounts[c.charge] = (offenseCounts[c.charge] || 0) + 1
    }
    for (const cat of cats) categoryCounts[cat] = (categoryCounts[cat] || 0) + 1
  }
  const crimeTypes = {
    categories: topN(categoryCounts, 20).map(x => ({ ...x, pct: (x.count / totalBookings) * 100 })),
    severities: topN(severityCounts, 10).map(x => {
      const total = Object.values(severityCounts).reduce((a, b) => a + b, 0)
      return { ...x, pct: (x.count / total) * 100 }
    }),
    topOffenses: topN(offenseCounts, 15),
  }

  // --- Bail (per source only -- never combined, see file header) ---
  const bail = sourceIds.map(id => ({ source: id, ...bailStatsFor(bySource[id], BAIL_UNIT[id]) }))

  // --- Agencies (SCORE only -- the only source that publishes an arresting
  // agency; see scrapers/score.js) ---
  const agencyCharges = {}
  for (const e of bySource.score || []) {
    for (const c of e.charges || []) {
      if (!c.arrestAgency || !c.charge) continue
      agencyCharges[c.arrestAgency] = agencyCharges[c.arrestAgency] || {}
      agencyCharges[c.arrestAgency][c.charge] = (agencyCharges[c.arrestAgency][c.charge] || 0) + 1
    }
  }
  const agencies = Object.entries(agencyCharges)
    .map(([agency, charges]) => {
      const chargeCount = Object.values(charges).reduce((a, b) => a + b, 0)
      return { agency, chargeCount, topCharges: topN(charges, 5) }
    })
    .sort((a, b) => b.chargeCount - a.chargeCount)

  // --- Detention duration by category (per source, county-verified releases only) ---
  const detention = {}
  for (const id of sourceIds) {
    const byCategory = {}
    for (const e of countyReleased(bySource[id])) {
      const days = daysBetween(e.bookingDate || e.firstSeen, e.releasedAt)
      if (days === null) continue
      const cats = new Set((e.charges || []).filter(c => c.charge).map(c => categorizeCharge(c.charge)))
      for (const cat of cats) {
        byCategory[cat] = byCategory[cat] || []
        byCategory[cat].push(days)
      }
    }
    detention[id] = {
      n: countyReleased(bySource[id]).length,
      rows: Object.entries(byCategory)
        .filter(([, vals]) => vals.length >= 2)
        .map(([category, vals]) => ({ category, avgDays: mean(vals), medianDays: median(vals), n: vals.length }))
        .sort((a, b) => b.avgDays - a.avgDays),
    }
  }

  // --- Repeat bookings (SCORE + Kent only — both have per-person booking
  // history from the source itself; Kirkland and KC DAJD do not)
  // Definition: had another booking at this same jail in the 12 months
  // before this booking.
  //
  // SCORE's bookingHistory includes the current booking; it's excluded by
  // matching bookingNumber so it doesn't count as a prior booking against
  // itself. Kent's priorBookings already contains only prior bookings.
  // Null histories are excluded from both rates.
  function repeatRateFor(entries, historyKey, priorDateKey, selfBookingKey) {
    let included = 0, repeats = 0, nullExcluded = 0
    const dates = []
    for (const e of entries) {
      const hist = e[historyKey]
      if (hist === null || hist === undefined) { nullExcluded++; continue }
      included++
      const curDate = new Date(e.bookingDate)
      if (isNaN(curDate)) continue
      dates.push(curDate)
      const twelveBack = new Date(curDate)
      twelveBack.setFullYear(twelveBack.getFullYear() - 1)
      const others = selfBookingKey
        ? hist.filter(h => h[selfBookingKey] !== e.bookingNumber)
        : hist
      if (others.some(h => {
        const d = new Date(h[priorDateKey])
        return !isNaN(d) && d >= twelveBack && d < curDate
      })) repeats++
    }
    return {
      included,
      nullExcluded,
      repeats,
      rate: included > 0 ? repeats / included : null,
      dateRange: dates.length
        ? { min: new Date(Math.min(...dates)), max: new Date(Math.max(...dates)) }
        : null,
    }
  }

  const repeatRates = {
    score: repeatRateFor(bySource.score || [], 'bookingHistory', 'dateBooked', 'bookingNumber'),
    kent: repeatRateFor(bySource.kent || [], 'priorBookings', 'bookedDate', 'bookingNumber'),
    kirkland: null,
    kc_dajd: null,
  }

  return { totals, trends, crimeTypes, stayLength, bail, agencies, detention, repeatRates }
}
