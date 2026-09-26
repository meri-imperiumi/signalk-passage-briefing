# Changelog

## Unreleased

### Added

- Plugin skeleton: Signal K lifecycle (`plugin/index.js`) with the SPEC
  §2.1 configuration schema, delta subscriptions for
  `network.internet.state`, `navigation.state` and house state of
  charge, and a one-minute cron ticker.
- Connection & navigation state machine (`plugin/state-machine.js`,
  SPEC §2.2): OFFLINE / TRIGGER_ONESHOT / STANDBY_OFFSHORE /
  PERSISTENT_CRON with edge-triggered oneshot fetches, the four UTC
  publication windows (02:15, 08:15, 14:15, 20:15) and the execution
  guard that disables cron fetching while sailing.
- SQLite engine (`plugin/sqlite-db.js`, SPEC §4.1): WAL-mode
  `node:sqlite` store with the logbook sail events, wind history cache
  and learned sail preference matrix tables, plus the SPEC §3.2/§4.2
  binning and EMA helpers.
- Smoketests for the state machine, the SQLite store and the plugin
  lifecycle.
