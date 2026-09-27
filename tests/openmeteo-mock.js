/**
 * Shared Open-Meteo fixtures and mock fetch for tests.
 */

const TIMES = ["2026-09-27T00:00", "2026-09-27T01:00"];

/**
 * @returns {object} Forecast API fixture (single location)
 */
function forecastFixture() {
  return {
    hourly: {
      time: TIMES,
      wind_speed_10m: [12, 14],
      wind_direction_10m: [45, 50],
      wind_gusts_10m: [18, 21],
      pressure_msl: [1013, 1012],
      cape: [200, 1200],
      temperature_850hPa: [15, 14],
      temperature_700hPa: [5, 4],
      temperature_500hPa: [-10, -11],
      relative_humidity_850hPa: [80, 82],
      relative_humidity_700hPa: [60, 65],
      wind_speed_850hPa: [20, 22],
      precipitable_water: [22.3, 24.1],
    },
  };
}

/**
 * @returns {object} Marine API wave fixture (GFS-Wave splits)
 */
function wavesFixture() {
  return {
    hourly: {
      time: TIMES,
      wave_height: [1.2, 1.4],
      wave_direction: [160, 165],
      wave_peak_period: [7, 7.5],
      wind_wave_height: [0.5, 0.6],
      wind_wave_period: [4, 4.2],
      wind_wave_direction: [170, 172],
      swell_wave_height: [0.9, 1.0],
      swell_wave_period: [9, 9.1],
      swell_wave_direction: [150, 152],
    },
  };
}

/**
 * @returns {object} Marine API current fixture (velocity in km/h)
 */
function currentsFixture() {
  return {
    hourly: {
      time: TIMES,
      ocean_current_velocity: [1.852, 0.926], // → 1 kn and 0.5 kn
      ocean_current_direction: [45, 46],
    },
  };
}

/**
 * Mock fetch keyed on the Open-Meteo endpoint in the URL.
 *
 * @param {object} [overrides] - Per-endpoint fixtures, or
 *   `throw: <url substring>` to fail that endpoint
 * @returns {typeof fetch}
 */
function mockOpenMeteo(overrides = {}) {
  return async (url) => {
    const u = String(url);
    if (overrides.throw && u.includes(overrides.throw)) {
      throw new Error("network down");
    }
    let body;
    if (u.includes("/v1/forecast")) {
      body = overrides.forecast ?? forecastFixture();
    } else if (u.includes("ncep_gfswave025")) {
      body = overrides.waves ?? wavesFixture();
    } else if (u.includes("ocean_current_velocity")) {
      body = overrides.currents ?? currentsFixture();
    } else {
      throw new Error(`Unexpected URL ${u}`);
    }
    return { ok: true, status: 200, json: async () => body };
  };
}

module.exports = {
  forecastFixture,
  wavesFixture,
  currentsFixture,
  mockOpenMeteo,
};
