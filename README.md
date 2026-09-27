# signalk-passage-briefing

Offshore passage daily briefing webapp for Signal K: a plugin that plans
and reviews passages for a cruising sailing vessel.

The plugin fetches multi-model weather along the planned route (online,
or via a GRIB/text spool when offline offshore), runs a step-forward
isochrone simulation with a monohull comfort model, learns the crew's
sail preferences from the electronic logbook, and serves a two-screen
webapp: a 24-hour tactical dashboard and a strategic passage summary.
See [SPEC.md](SPEC.md) for the full design.

Part of the Lille Ø offshore suite, alongside
[@meri-imperiumi/signalk-energy-predictor](https://github.com/meri-imperiumi/signalk-energy-predictator)
and [@meri-imperiumi/signalk-logbook](https://github.com/meri-imperiumi/signalk-logbook).

## Acknowledgments

The comfort model and the whole idea of "what will each departure
actually feel like" come from SV Sabado's
[passage-weather](https://github.com/sailing12388/passage-weather)
ensemble departure planner by Ray Hendricks. The Sereno comfort scale
(Champagne, Easy, Coffee, Rough, Sick), the encounter-period motion
math, and the ISO 2631-1 comfort bands are adapted from it for a
monohull (heel and waterline-pitch resonance instead of catamaran
beam-roll and bridgedeck slam).

## License

EUPL-1.2
