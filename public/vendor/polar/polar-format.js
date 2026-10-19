/* Vendored from polar-format@1.0.0 (Apache-2.0) — https://github.com/Asw1n/polar-format
 * — the canonical polar-table validator used by the vendored polar-math
 * (work doc #25). Sole change: the Ajv JSON-schema pass is replaced by an
 * equivalent structural check below (the runtime dependency was too heavy
 * for the browser worker); the table is also validated upstream by
 * signalk-polar-management, and this file's semantic rules are unchanged. */

'use strict'


const CANONICAL_UNITS = Object.freeze({
  tws: 'm/s',
  twa: 'rad',
  boatSpeed: 'm/s'
})

const SPEED_FACTORS_TO_MPS = Object.freeze({
  'm/s': 1,
  kn: 1 / 1.94384,
  kt: 1 / 1.94384,
  kts: 1 / 1.94384,
  knot: 1 / 1.94384,
  knots: 1 / 1.94384
})

const ANGLE_FACTORS_TO_RAD = Object.freeze({
  rad: 1,
  deg: Math.PI / 180,
  degree: Math.PI / 180,
  degrees: Math.PI / 180
})

const SUPPORTED_UNITS = Object.freeze({
  tws: Object.freeze(Object.keys(SPEED_FACTORS_TO_MPS)),
  twa: Object.freeze(Object.keys(ANGLE_FACTORS_TO_RAD)),
  boatSpeed: Object.freeze(Object.keys(SPEED_FACTORS_TO_MPS))
})


function ok(value) {
  return { valid: true, value, errors: [] }
}

function fail(errors) {
  return { valid: false, value: undefined, errors }
}

function error(path, message, keyword = 'polar-format') {
  return { path, message, keyword }
}

// Inline structural check standing in for the Ajv schema pass: the
// same constraints the JSON schema declares, without the runtime
// dependency. The table is validated upstream by
// signalk-polar-management as well.
function validateSchema(data) {
  if (data == null || typeof data !== "object") {
    return fail([error("/", "must be an object", "type")]);
  }
  const errors = [];
  const { kind, schemaVersion, units, axes, values } = data;
  if (kind !== "polarTable") {
    errors.push(error("/kind", 'must be "polarTable"', "const"));
  }
  if (
    typeof schemaVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(schemaVersion)
  ) {
    errors.push(
      error("/schemaVersion", "must use major.minor.patch versioning"),
    );
  }
  if (units == null || typeof units !== "object") {
    errors.push(error("/units", "must be an object"));
  } else {
    for (const key of ["tws", "twa", "boatSpeed"]) {
      if (typeof units[key] !== "string") {
        errors.push(error("/units/" + key, "must be a string"));
      }
    }
  }
  if (axes == null || typeof axes !== "object") {
    errors.push(error("/axes", "must be an object"));
  } else {
    if (!Array.isArray(axes.tws) || axes.tws.length < 2) {
      errors.push(error("/axes/tws", "must contain at least two points", "minItems"));
    } else if (
      axes.tws.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)
    ) {
      errors.push(error("/axes/tws", "must contain only non-negative finite numbers"));
    }
    if (!Array.isArray(axes.twa) || axes.twa.length < 2) {
      errors.push(error("/axes/twa", "must contain at least two points", "minItems"));
    } else if (
      axes.twa.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)
    ) {
      errors.push(error("/axes/twa", "must contain only non-negative finite numbers"));
    }
  }
  const rows = values?.boatSpeedMatrix;
  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push(error("/values/boatSpeedMatrix", "must be a non-empty array"));
  } else if (Array.isArray(axes?.tws) && rows.length !== axes.tws.length) {
    errors.push(error("/values/boatSpeedMatrix", "must match the TWS axis length"));
  } else if (Array.isArray(axes?.twa)) {
    rows.forEach((row, index) => {
      if (!Array.isArray(row) || row.length !== axes.twa.length) {
        errors.push(error("/values/boatSpeedMatrix/" + index, "must match the TWA axis length"));
      } else if (
        row.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)
      ) {
        errors.push(
          error("/values/boatSpeedMatrix/" + index, "must contain only non-negative finite numbers"),
        );
      }
    });
  }
  return errors.length === 0 ? ok(data) : fail(errors);
}

function validatePolarTable(data) {
  const structural = validateSchema(data)
  if (!structural.valid) return structural
  const errors = [...validateSemanticRules(data)]
  return errors.length === 0 ? ok(data) : fail(errors)
}

function toCanonicalPolarTable(data) {
  const conversion = convertPolarTableUnits(data, CANONICAL_UNITS)
  if (!conversion.valid) return conversion
  return validatePolarTable(conversion.value)
}

function convertPolarTableUnits(data, targetUnits) {
  const shapeErrors = validateConvertibleShape(data)
  if (shapeErrors.length > 0) return fail(shapeErrors)

  const sourceUnits = data.units
  const targetErrors = validateTargetUnits(targetUnits)
  if (targetErrors.length > 0) return fail(targetErrors)

  const twsFactor = conversionFactor(sourceUnits.tws, targetUnits.tws, SPEED_FACTORS_TO_MPS)
  const twaFactor = conversionFactor(sourceUnits.twa, targetUnits.twa, ANGLE_FACTORS_TO_RAD)
  const boatSpeedFactor = conversionFactor(sourceUnits.boatSpeed, targetUnits.boatSpeed, SPEED_FACTORS_TO_MPS)

  const converted = {
    ...data,
    units: { ...targetUnits },
    axes: {
      tws: data.axes.tws.map(value => value * twsFactor),
      twa: data.axes.twa.map(value => value * twaFactor)
    },
    values: {
      boatSpeedMatrix: data.values.boatSpeedMatrix.map(row => row.map(value => value * boatSpeedFactor))
    }
  }

  if (data.derived) {
    converted.derived = convertDerived(data.derived, twsFactor, twaFactor, boatSpeedFactor)
  }

  return ok(converted)
}

function conversionFactor(sourceUnit, targetUnit, factorsToBase) {
  return factorsToBase[sourceUnit] / factorsToBase[targetUnit]
}

function convertDerived(derived, twsFactor, twaFactor, boatSpeedFactor) {
  if (!Array.isArray(derived.rows)) return { ...derived }
  return {
    ...derived,
    rows: derived.rows.map(row => ({
      ...row,
      tws: row.tws * twsFactor,
      ...(row.beat === undefined ? {} : { beat: convertTarget(row.beat, twaFactor, boatSpeedFactor) }),
      ...(row.run === undefined ? {} : { run: convertTarget(row.run, twaFactor, boatSpeedFactor) }),
      ...(row.maxSpeed === undefined ? {} : { maxSpeed: row.maxSpeed * boatSpeedFactor }),
      ...(row.maxSpeedAngle === undefined ? {} : { maxSpeedAngle: row.maxSpeedAngle * twaFactor })
    }))
  }
}

function convertTarget(target, twaFactor, boatSpeedFactor) {
  if (target === null) return null
  return {
    ...target,
    twa: target.twa * twaFactor,
    tbs: target.tbs * boatSpeedFactor,
    vmg: target.vmg * boatSpeedFactor
  }
}

function validateConvertibleShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [error('/', 'Expected a polar table object')]
  }

  const errors = []
  if (data.kind !== 'polarTable') errors.push(error('/kind', 'must be polarTable'))
  if (!isMajorMinorPatch(data.schemaVersion)) errors.push(error('/schemaVersion', 'must use major.minor.patch versioning'))
  if (data.symmetry?.portStarboardSymmetric !== true) errors.push(error('/symmetry/portStarboardSymmetric', 'must be true'))

  errors.push(...validateSourceUnits(data.units))
  errors.push(...validateNumericArray(data.axes?.tws, '/axes/tws', { minExclusive: 0 }))
  errors.push(...validateNumericArray(data.axes?.twa, '/axes/twa', { min: 0 }))
  errors.push(...validateMatrix(data.values?.boatSpeedMatrix, data.axes?.tws, data.axes?.twa))
  errors.push(...validateSemanticRules(data, { skipCanonicalRange: true }))
  return errors
}

function validateSourceUnits(units) {
  if (!units || typeof units !== 'object' || Array.isArray(units)) return [error('/units', 'Expected units object')]
  const errors = []
  if (!SUPPORTED_UNITS.tws.includes(units.tws)) errors.push(error('/units/tws', `unsupported TWS unit '${units.tws}'`))
  if (!SUPPORTED_UNITS.twa.includes(units.twa)) errors.push(error('/units/twa', `unsupported TWA unit '${units.twa}'`))
  if (!SUPPORTED_UNITS.boatSpeed.includes(units.boatSpeed)) errors.push(error('/units/boatSpeed', `unsupported boatSpeed unit '${units.boatSpeed}'`))
  return errors
}

function validateTargetUnits(units) {
  if (!units || typeof units !== 'object' || Array.isArray(units)) return [error('/targetUnits', 'Expected target units object')]
  const errors = []
  if (!SUPPORTED_UNITS.tws.includes(units.tws)) errors.push(error('/targetUnits/tws', `unsupported TWS unit '${units.tws}'`))
  if (!SUPPORTED_UNITS.twa.includes(units.twa)) errors.push(error('/targetUnits/twa', `unsupported TWA unit '${units.twa}'`))
  if (!SUPPORTED_UNITS.boatSpeed.includes(units.boatSpeed)) errors.push(error('/targetUnits/boatSpeed', `unsupported boatSpeed unit '${units.boatSpeed}'`))
  return errors
}

function validateNumericArray(values, path, { min, minExclusive } = {}) {
  if (!Array.isArray(values) || values.length === 0) return [error(path, 'must be a non-empty array')]
  return values.flatMap((value, index) => {
    const itemErrors = []
    if (!Number.isFinite(value)) itemErrors.push(error(`${path}/${index}`, 'must be a finite number'))
    if (Number.isFinite(min) && value < min) itemErrors.push(error(`${path}/${index}`, `must be >= ${min}`))
    if (Number.isFinite(minExclusive) && value <= minExclusive) itemErrors.push(error(`${path}/${index}`, `must be > ${minExclusive}`))
    return itemErrors
  })
}

function validateMatrix(matrix, twsAxis, twaAxis) {
  if (!Array.isArray(matrix)) return [error('/values/boatSpeedMatrix', 'must be an array')]
  const errors = []
  if (Array.isArray(twsAxis) && matrix.length !== twsAxis.length) {
    errors.push(error('/values/boatSpeedMatrix', 'row count must match axes.tws length'))
  }

  matrix.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      errors.push(error(`/values/boatSpeedMatrix/${rowIndex}`, 'must be an array'))
      return
    }
    if (Array.isArray(twaAxis) && row.length !== twaAxis.length) {
      errors.push(error(`/values/boatSpeedMatrix/${rowIndex}`, 'length must match axes.twa length'))
    }
    errors.push(...validateNumericArray(row, `/values/boatSpeedMatrix/${rowIndex}`, { min: 0 }))
  })
  return errors
}

function validateSemanticRules(data, options = {}) {
  const errors = []
  errors.push(...validateStrictlyIncreasing(data.axes.tws, '/axes/tws'))
  errors.push(...validateStrictlyIncreasing(data.axes.twa, '/axes/twa'))
  errors.push(...validateMatrix(data.values.boatSpeedMatrix, data.axes.tws, data.axes.twa))

  if (!options.skipCanonicalRange) {
    errors.push(...validateCanonicalTwaRange(data.axes.twa, '/axes/twa'))
    if (data.derived?.rows) errors.push(...validateDerivedRows(data.derived.rows))
  }

  return errors
}

function validateStrictlyIncreasing(values, path) {
  if (!Array.isArray(values)) return []
  const errors = []
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] <= values[index - 1]) {
      errors.push(error(`${path}/${index}`, 'must be strictly increasing'))
    }
  }
  return errors
}

function validateCanonicalTwaRange(values, path) {
  if (!Array.isArray(values)) return []
  return values.flatMap((value, index) => value > Math.PI
    ? [error(`${path}/${index}`, 'must be <= pi radians')]
    : [])
}

function validateDerivedRows(rows) {
  const errors = []
  rows.forEach((row, rowIndex) => {
    if (row.beat) errors.push(...validateTargetRange(row.beat, `/derived/rows/${rowIndex}/beat`))
    if (row.run) errors.push(...validateTargetRange(row.run, `/derived/rows/${rowIndex}/run`))
    if (Number.isFinite(row.maxSpeedAngle) && row.maxSpeedAngle > Math.PI) {
      errors.push(error(`/derived/rows/${rowIndex}/maxSpeedAngle`, 'must be <= pi radians'))
    }
  })
  return errors
}

function validateTargetRange(target, path) {
  return Number.isFinite(target.twa) && target.twa > Math.PI
    ? [error(`${path}/twa`, 'must be <= pi radians')]
    : []
}

function isMajorMinorPatch(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)
}

export {
  CANONICAL_UNITS,
  SUPPORTED_UNITS,
  validatePolarTable,
  toCanonicalPolarTable,
  convertPolarTableUnits
}