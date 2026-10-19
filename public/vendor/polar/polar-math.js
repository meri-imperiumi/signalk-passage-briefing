/* Vendored from polar-math@1.1.1 (Apache-2.0) — https://github.com/Asw1n/polar-math — prepared polar-table interpolation (PCHIP) with modeled pinch/in-irons and run extrapolation (work doc #25). Sole change: the CommonJS module shape is converted to ESM for the browser worker; the logic is unchanged. */

'use strict'

import { validatePolarTable } from "./polar-format.js";

const PINCH_FACTOR = 0.8
const BEAT_ENDPOINT_ANGLE = 25 * Math.PI / 180
const EPSILON = 1e-9
const DEFAULT_PERFORMANCE_FACTOR = 1.0

function validState(tws, twa = null) {
  return { available: true, tws, twa }
}

function invalidState() {
  return { available: false, reason: 'invalid_input', tws: null, twa: null }
}

function noDataState() {
  return { available: false, reason: 'no_data', tws: null, twa: null }
}

function queryOptions(options, requireTwa) {
  const { tws, twa, performanceFactor = DEFAULT_PERFORMANCE_FACTOR, extrapolate = true } = options || {}
  if (!Number.isFinite(tws) || !Number.isFinite(performanceFactor) || performanceFactor < 0 ||
      (requireTwa && (!Number.isFinite(twa) || Math.abs(twa) > Math.PI))) return null
  return { tws, twa, performanceFactor, extrapolate: extrapolate !== false }
}

function interpolate(a, b, ratio) {
  return a + ratio * (b - a)
}

function roundToTwoDecimals(value) {
  return Math.round(value * 100) / 100
}

class Polar {
  static fromTable(table) {
    const validation = validatePolarTable(table)
    if (!validation.valid) {
      throw new TypeError(`Invalid polar table: ${validation.errors.map(error => `${error.path} ${error.message}`).join('; ')}`)
    }
    return new Polar(table)
  }

  constructor(table) {
    // validatePolarTable requires symmetry.portStarboardSymmetric === true; queries below rely on that
    // and always mirror speed across the beam (Math.abs(twa)). There is no asymmetric-table support yet.
    this.entries = prepareEntries(table)
    Object.freeze(this.entries)
  }

  speedAt(options) {
    const input = queryOptions(options, true)
    if (!input) return { value: null, state: invalidState() }
    if (this.entries.length === 0) return { value: null, state: noDataState() }

    const { tws, twa, performanceFactor, extrapolate } = input
    const interpolation = this.findTwsInterpolation(tws)
    const state = this.stateAt(tws, twa, extrapolate, interpolation)
    if (state.twa === 'below_range' || state.twa === 'in_irons' || state.twa === 'above_range') {
      return { value: null, state }
    }

    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    const normalizedTwa = Math.abs(twa)
    const lowerSpeed = speedFromEntry(lower, normalizedTwa, extrapolate)
    const upperSpeed = speedFromEntry(upper, normalizedTwa, extrapolate)
    if (lowerSpeed === null || upperSpeed === null) return { value: null, state }

    return { value: interpolate(lowerSpeed, upperSpeed, interpolation.ratio) * performanceFactor, state }
  }

  vmgAt(options) {
    const input = queryOptions(options, true)
    if (!input) return { value: null, state: invalidState() }

    const speed = this.speedAt(input)
    return { value: speed.value === null ? null : speed.value * Math.cos(input.twa), state: speed.state }
  }

  targetsAt(options) {
    const input = queryOptions(options, false)
    if (!input) return { value: null, state: invalidState() }
    if (this.entries.length === 0) return { value: null, state: noDataState() }

    const interpolation = this.findTwsInterpolation(input.tws)
    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    const scale = input.performanceFactor
    const target = (key) => interpolate(lower[key], upper[key], interpolation.ratio)
    const maxSpeed = target('maxSpeed') * scale
    const sideTarget = (name) => {
      const angleKey = `${name}Angle`
      const speedKey = `${name}Speed`
      const vmgKey = `${name}Vmg`
      if (!Number.isFinite(lower[angleKey]) || !Number.isFinite(upper[angleKey])) return null
      return {
        twa: target(angleKey),
        speed: target(speedKey) * scale,
        vmg: target(vmgKey) * scale
      }
    }

    return {
      value: {
        beat: sideTarget('beat'),
        run: sideTarget('run'),
        maxSpeed: { twa: target('maxSpeedAngle'), speed: maxSpeed }
      },
      state: validState(this.twsState(input.tws), null)
    }
  }

  rangeAt(options) {
    const input = queryOptions(options, false)
    if (!input) return { value: null, state: invalidState() }
    if (this.entries.length === 0) return { value: null, state: noDataState() }

    const interpolation = this.findTwsInterpolation(input.tws)
    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    return {
      value: {
        minTwa: interpolate(minTwaForEntry(lower, input.extrapolate), minTwaForEntry(upper, input.extrapolate), interpolation.ratio),
        maxTwa: interpolate(maxTwaForEntry(lower, input.extrapolate), maxTwaForEntry(upper, input.extrapolate), interpolation.ratio)
      },
      state: validState(this.twsState(input.tws), null)
    }
  }

  findTwsInterpolation(tws) {
    let lowerIndex = -1
    let upperIndex = -1
    for (let index = 0; index < this.entries.length; index += 1) {
      if (this.entries[index].tws <= tws) lowerIndex = index
      if (this.entries[index].tws >= tws && upperIndex === -1) upperIndex = index
    }
    if (lowerIndex === -1) return { lowerIndex: 0, upperIndex: 0, ratio: 0 }
    if (upperIndex === -1) {
      const lastIndex = this.entries.length - 1
      return { lowerIndex: lastIndex, upperIndex: lastIndex, ratio: 0 }
    }
    if (lowerIndex === upperIndex) return { lowerIndex, upperIndex, ratio: 0 }
    return {
      lowerIndex,
      upperIndex,
      ratio: (tws - this.entries[lowerIndex].tws) / (this.entries[upperIndex].tws - this.entries[lowerIndex].tws)
    }
  }

  twsState(tws) {
    const first = this.entries[1] || this.entries[0]
    const last = this.entries.at(-1)
    if (tws < first.tws) return 'below_range'
    if (tws > last.tws) return 'above_range'
    return 'in_range'
  }

  stateAt(tws, twa, extrapolate = true, interpolation = this.findTwsInterpolation(tws)) {
    if (this.entries.length === 0) return noDataState()

    const normalizedTwa = Math.abs(twa)
    const lower = this.entries[interpolation.lowerIndex]
    const upper = this.entries[interpolation.upperIndex]
    const minTwa = interpolate(minTwaForEntry(lower, extrapolate), minTwaForEntry(upper, extrapolate), interpolation.ratio)
    const maxTwa = interpolate(maxTwaForEntry(lower, extrapolate), maxTwaForEntry(upper, extrapolate), interpolation.ratio)

    if (!extrapolate) {
      let twaState = 'in_range'
      if (normalizedTwa < minTwa) twaState = 'below_range'
      else if (normalizedTwa > maxTwa) twaState = 'above_range'
      return validState(this.twsState(tws), twaState)
    }

    const hasBeat = Number.isFinite(lower.beatAngle) && Number.isFinite(upper.beatAngle)
    const beatAngle = hasBeat ? interpolate(lower.beatAngle, upper.beatAngle, interpolation.ratio) : null
    let twaState = 'in_range'
    if (normalizedTwa < minTwa) twaState = hasBeat ? 'in_irons' : 'below_range'
    else if (hasBeat && normalizedTwa < beatAngle) twaState = 'pinching'
    else {
      const lastTwa = Math.max(lower.points.at(-1).twa, upper.points.at(-1).twa)
      if (normalizedTwa > maxTwa) twaState = 'above_range'
      else if (normalizedTwa > lastTwa) twaState = 'extrapolated'
    }
    return validState(this.twsState(tws), twaState)
  }
}

function prepareEntries(table) {
  const targets = fillDerivedTargets(table.axes.tws, table.derived?.rows || [])
  const entries = table.axes.tws.flatMap((tws, rowIndex) => {
    const axisPoints = table.axes.twa
      .map((twa, colIndex) => ({ twa, speed: table.values.boatSpeedMatrix[rowIndex][colIndex] }))
      .filter(point => point.speed > 0)
    if (axisPoints.length === 0) return []

    const points = axisPoints.slice()
    const target = {
      beat: points.some(point => point.twa < Math.PI / 2) ? targets[rowIndex].beat : null,
      run: points.some(point => point.twa >= Math.PI / 2) ? targets[rowIndex].run : null
    }
    addTarget(points, target.beat)
    addTarget(points, target.run)
    points.sort((a, b) => a.twa - b.twa)
    const derived = deriveTargets(points, target)
    const realPoints = points.slice()

    const extended = addRunExtension(axisPoints, addBeatExtension(points, derived), derived)
    const tangents = pchipTangents(extended)
    const realTangents = pchipTangents(realPoints)
    const runFlatten = buildRunFlatten(extended, tangents, derived)

    return [{ tws, points: extended, tangents, realPoints, realTangents, runFlatten, ...derived }]
  })

  if (entries.length === 0) return []

  const first = entries[0]
  entries.unshift({
    tws: 0.0001,
    points: first.points.map(point => ({ ...point, speed: 0 })),
    tangents: first.tangents.map(() => 0),
    realPoints: first.realPoints.map(point => ({ ...point, speed: 0 })),
    realTangents: first.realTangents.map(() => 0),
    runFlatten: first.runFlatten ? { ...first.runFlatten, anchorVmg: 0, a: 0, b: 0 } : null,
    beatAngle: first.beatAngle,
    beatSpeed: 0,
    beatVmg: 0,
    runAngle: first.runAngle,
    runSpeed: 0,
    runVmg: 0,
    maxSpeed: 0,
    maxSpeedAngle: first.maxSpeedAngle
  })
  return entries.map(entry => Object.freeze({
    ...entry,
    points: Object.freeze(entry.points.map(Object.freeze)),
    realPoints: Object.freeze(entry.realPoints.map(Object.freeze)),
    tangents: Object.freeze(entry.tangents),
    realTangents: Object.freeze(entry.realTangents)
  }))
}

// Prepends a synthetic zero-speed endpoint so the PCHIP curve reaches 25deg on
// the beat side without using the query cutoff to shape the curve.
function addBeatExtension(points, derived) {
  if (!Number.isFinite(derived.beatAngle) || derived.beatAngle <= BEAT_ENDPOINT_ANGLE) return points
  if (points[0].twa <= BEAT_ENDPOINT_ANGLE + EPSILON) return points
  return [{ twa: BEAT_ENDPOINT_ANGLE, speed: 0 }, ...points]
}

// Extends the run side of the curve with at most one mirrored point beyond the
// deepest known angle (see buildRunFlatten for the quadratic VMG taper to 180deg
// that starts from this extended point list).
function addRunExtension(axisPoints, points, derived) {
  if (!Number.isFinite(derived.runAngle)) return points

  const referenceAngle = findReferenceAngle(axisPoints, derived.runAngle)
  if (referenceAngle === null) return points

  let mirrorAngle = 2 * derived.runAngle - referenceAngle
  if (Math.abs(mirrorAngle - Math.PI) < EPSILON) mirrorAngle = Math.PI // snap float noise onto the exact boundary
  const maxKnownAngle = points.at(-1).twa
  const mirrorCosine = Math.abs(Math.cos(mirrorAngle))
  // Skip the mirror point entirely if its true (uncapped) position is beyond
  // 180deg -- placing it clamped at pi would encode the wrong VMG right at the
  // boundary and short-circuit the smooth taper below.
  if (mirrorAngle > Math.PI || mirrorAngle <= maxKnownAngle + EPSILON || mirrorCosine <= EPSILON) return points

  const reference = axisPoints.find(point => point.twa === referenceAngle)
  const referenceVmg = reference.speed * Math.abs(Math.cos(reference.twa))
  const mirrorSpeed = Math.max(0, referenceVmg / mirrorCosine)
  return [...points, { twa: mirrorAngle, speed: mirrorSpeed }].sort((a, b) => a.twa - b.twa)
}

// Quadratic VMG taper from the deepest known point (mirror point, or the last
// real point if no mirror was added) to zero VMG slope at 180deg. The initial
// slope comes from the PCHIP tangent at that point (dSpeed/dTWA), converted to
// dVMG/dTWA via the product rule so the taper is slope-continuous with the
// interior curve rather than restarting from a separate secant estimate.
function buildRunFlatten(points, tangents, derived) {
  if (!Number.isFinite(derived.runAngle)) return null
  const anchor = points.at(-1)
  if (points.length < 2 || anchor.twa >= Math.PI - EPSILON) return null

  const anchorVmg = anchor.speed * Math.abs(Math.cos(anchor.twa))
  const speedSlope = tangents.at(-1)
  // VMG magnitude = -speed*cos(twa) for twa in (pi/2, pi]; differentiate via the product rule.
  let slope = -speedSlope * Math.cos(anchor.twa) + anchor.speed * Math.sin(anchor.twa)
  slope = Math.min(0, slope) // VMG may never increase
  const distanceToEnd = Math.PI - anchor.twa

  return { anchorTwa: anchor.twa, anchorVmg, a: -slope / (2 * distanceToEnd), b: slope }
}

// Biggest axis-defined TWA (with real data) below the rounded run angle.
function findReferenceAngle(axisPoints, runAngle) {
  const roundedRunDeg = Math.round(runAngle * 180 / Math.PI)
  let best = null
  for (const point of axisPoints) {
    const deg = Math.round(point.twa * 180 / Math.PI)
    if (deg < roundedRunDeg && (best === null || point.twa > best)) best = point.twa
  }
  return best
}

// Fritsch-Carlson monotone cubic Hermite (PCHIP) tangents for a sorted point list.
// Interior tangents use a weighted harmonic mean of the two adjacent secants (zero
// at local extrema, so the curve never overshoots between real points); endpoint
// tangents use the standard one-sided three-point estimate with the same
// shape-preserving clamp.
function pchipTangents(points) {
  const n = points.length
  const tangents = new Array(n).fill(0)
  if (n < 2) return tangents

  const h = []
  const m = []
  for (let i = 0; i < n - 1; i += 1) {
    h.push(points[i + 1].twa - points[i].twa)
    m.push((points[i + 1].speed - points[i].speed) / h[i])
  }

  if (n === 2) {
    tangents[0] = m[0]
    tangents[1] = m[0]
    return tangents
  }

  for (let i = 1; i < n - 1; i += 1) {
    if (m[i - 1] === 0 || m[i] === 0 || (m[i - 1] > 0) !== (m[i] > 0)) {
      tangents[i] = 0
    } else {
      const w1 = 2 * h[i] + h[i - 1]
      const w2 = h[i] + 2 * h[i - 1]
      tangents[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i])
    }
  }
  tangents[0] = pchipEndpointTangent(h[0], h[1], m[0], m[1])
  tangents[n - 1] = pchipEndpointTangent(h[n - 2], h[n - 3], m[n - 2], m[n - 3])
  return tangents
}

function pchipEndpointTangent(h0, h1, m0, m1) {
  let tangent = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1)
  if (tangent !== 0 && m0 !== 0 && (tangent > 0) !== (m0 > 0)) tangent = 0
  else if (m0 !== 0 && m1 !== 0 && (m0 > 0) !== (m1 > 0) && Math.abs(tangent) > Math.abs(3 * m0)) tangent = 3 * m0
  return tangent
}

// Evaluates the monotone cubic Hermite curve at twa; null below the first point.
function evaluatePchip(points, tangents, twa) {
  if (twa < points[0].twa) return null
  if (points.length === 1) return twa === points[0].twa ? points[0].speed : null

  let index = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    if (points[i].twa <= twa) index = i
  }
  if (index === points.length - 1) return points[index].speed

  const p0 = points[index]
  const p1 = points[index + 1]
  const h = p1.twa - p0.twa
  const t = (twa - p0.twa) / h
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return Math.max(0, h00 * p0.speed + h10 * h * tangents[index] + h01 * p1.speed + h11 * h * tangents[index + 1])
}

function addTarget(points, target) {
  if (!target) return
  const index = points.findIndex(point => point.twa === target.twa)
  const point = { twa: target.twa, speed: target.tbs }
  if (index >= 0) points[index] = point
  else points.push(point)
}

function deriveTargets(points, target) {
  const best = (predicate) => points.filter(predicate).reduce((result, point) =>
    !result || point.speed * Math.abs(Math.cos(point.twa)) > result.speed * Math.abs(Math.cos(result.twa)) ? point : result, null)
  const beat = target.beat || best(point => point.twa < Math.PI / 2)
  const run = target.run || best(point => point.twa >= Math.PI / 2)
  const max = points.reduce((result, point) => point.speed > result.speed ? point : result, points[0])
  return {
    beatAngle: beat?.twa ?? null, beatSpeed: beat ? beat.tbs ?? beat.speed : null,
    beatVmg: beat ? roundToTwoDecimals(beat.vmg ?? beat.speed * Math.abs(Math.cos(beat.twa))) : null,
    runAngle: run?.twa ?? null, runSpeed: run ? run.tbs ?? run.speed : null,
    runVmg: run ? roundToTwoDecimals(run.vmg ?? run.speed * Math.abs(Math.cos(run.twa))) : null,
    maxSpeed: max.speed, maxSpeedAngle: max.twa
  }
}

function speedFromEntry(entry, twa, extrapolate) {
  const points = extrapolate ? entry.points : entry.realPoints
  const tangents = extrapolate ? entry.tangents : entry.realTangents
  const last = points.at(-1)
  if (twa > last.twa) {
    if (!extrapolate || !entry.runFlatten) return null
    const x = twa - entry.runFlatten.anchorTwa
    const vmg = Math.min(entry.runFlatten.anchorVmg, entry.runFlatten.anchorVmg + entry.runFlatten.b * x + entry.runFlatten.a * x * x)
    const cosine = Math.abs(Math.cos(twa)) // vmg is a magnitude (see buildRunFlatten); keep the conversion sign-consistent
    return cosine < EPSILON ? null : Math.max(0, vmg / cosine)
  }
  return evaluatePchip(points, tangents, twa)
}

function minTwaForEntry(entry, extrapolate) {
  if (!extrapolate) return entry.realPoints[0].twa
  return Number.isFinite(entry.beatAngle)
    ? BEAT_ENDPOINT_ANGLE + PINCH_FACTOR * (entry.beatAngle - BEAT_ENDPOINT_ANGLE)
    : entry.points[0].twa
}

function maxTwaForEntry(entry, extrapolate) {
  if (!extrapolate) return entry.realPoints.at(-1).twa
  return entry.runFlatten ? Math.PI : entry.points.at(-1).twa
}

function fillDerivedTargets(twsAxis, rows) {
  const targets = twsAxis.map(tws => {
    const row = rows.find(candidate => Math.abs(candidate.tws - tws) < 1e-6)
    return {
      beat: validTarget(row?.beat) ? { ...row.beat } : null,
      run: validTarget(row?.run) ? { ...row.run } : null
    }
  })
  for (const key of ['beat', 'run']) {
    for (let index = 0; index < targets.length; index += 1) {
      if (targets[index][key]) continue
      const lower = findTarget(targets, key, index, -1)
      const upper = findTarget(targets, key, index, 1)
      if (lower >= 0 && upper >= 0) {
        const ratio = (twsAxis[index] - twsAxis[lower]) / (twsAxis[upper] - twsAxis[lower])
        const low = targets[lower][key]
        const high = targets[upper][key]
        const twa = interpolate(low.twa, high.twa, ratio)
        const tbs = interpolate(low.tbs, high.tbs, ratio)
        targets[index][key] = { twa, tbs, vmg: tbs * Math.abs(Math.cos(twa)) }
      } else if (lower >= 0) targets[index][key] = { ...targets[lower][key] }
      else if (upper >= 0) targets[index][key] = { ...targets[upper][key] }
    }
  }
  return targets
}

function validTarget(target) {
  return Number.isFinite(target?.twa) && Number.isFinite(target?.tbs)
}

function findTarget(targets, key, from, direction) {
  for (let index = from + direction; index >= 0 && index < targets.length; index += direction) {
    if (targets[index][key]) return index
  }
  return -1
}

export { Polar }