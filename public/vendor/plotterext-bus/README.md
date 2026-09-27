signalk-plotterext-bus 0.11.0, vendored as static browser assets (no npm
dependency, no build tooling — same policy as vendor/leaflet). Fetched via
`npm pack signalk-plotterext-bus@0.11.0`, dist files only:

- extension.js (the /extension entry, re-exports the client)
- chunk-7XRFPDQL.js (ExtensionClient + connectExtension)
- host.js (the /host entry, re-exports HostConnection + protocol core)
- chunk-RED55KML.js (HostConnection: subscriptions, handshake)
- chunk-4W6N34SD.js (bus protocol core: envelope, JSON-RPC, wildcard
  events — shared by both entries)
- LICENSE (MIT, Copyright (c) 2026 Joel Kozikowski)

Both sides are vendored: the extension client runs inside our
`dr-ext-widget.html` iframe on host chartplotters (Freeboard-SK), and
HostConnection powers the DR webapp's own plotter-extension host
(dr-ext-host.js, work doc #27). The documented wire format is the
contract — see plotter-extensions.md.
