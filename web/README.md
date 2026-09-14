# Web app

`index.html` is the whole app: no build step, no dependencies. It is published
as a Claude Artifact and stores the league in that artifact's database.

`verify-engine.cjs` checks the JavaScript engine against the same scenarios as
the Python test suite. It needs the engine extracted from the page first:

```bash
python3 - <<'PY'
s = open('web/index.html').read()
js = s.split('<script>\n"use strict";', 1)[1].rsplit('</script>', 1)[0]
tail = "\nmodule.exports = { D, plain, rdiv, mul, dvd, qCash, qPrice, absD, fmtMoney, fmtSigned, fmtPct, fmtShares, pctOf, S, ZERO, state, rules, commissionOn, cashDelta, replay, valuate, standings, positionOf, checkTrade, slug, encSym };\n"
head = """
const stub = new Proxy({}, { get: () => () => {}, set: () => true });
global.document = { querySelector: () => stub, querySelectorAll: () => [], addEventListener: () => {} };
global.window = { scrollTo: () => {} };
global.claude = { use: async () => null };
global.alert = () => {};
global.setInterval = () => 0;
"""
open('web/engine.cjs', 'w').write(head + js + tail)
PY
node web/verify-engine.cjs
```
