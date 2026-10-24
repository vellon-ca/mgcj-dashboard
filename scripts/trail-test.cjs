// Logic test for src/lib/trail.ts stop detection. No test runner exists in this
// repo, so this transpiles the module with typescript into a temp dir and asserts.
// Run: node scripts/trail-test.cjs
const path = require('path'), fs = require('fs'), os = require('os')
const ROOT = path.resolve(__dirname, '..')
const ts = require(path.join(ROOT, 'node_modules/typescript'))
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'trail-'))
const src = fs.readFileSync(path.join(ROOT, 'src/lib/trail.ts'), 'utf8')
fs.writeFileSync(path.join(OUT, 'trail.js'),
  ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)
const { buildTrail } = require(path.join(OUT, 'trail.js'))

let pass = 0, fail = 0
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + JSON.stringify(d))) }

const T0 = Date.parse('2026-10-23T18:00:00Z')
const min = m => T0 + m * 60_000
const at = (m, northM, ride = null) => ({ recorded_at: new Date(min(m)).toISOString(), lat: 45.0772 + northM / 111_000, lng: -64.496, ride_id: ride })
const stopsOf = (fixes, shifts = [], now = min(600)) => buildTrail(fixes, shifts, now).stops

// The case the old code missed: ONE fix on arrival, then nothing until the car
// moves 150 m, 42 minutes later.
let s = stopsOf([at(0, 0), at(1, 200), at(2, 400), at(44, 600), at(45, 800)])
ok('single parked fix is a stop until the departure fix', s.length === 1 && s[0].from === min(2) && s[0].to === min(44) && s[0].minutes === 42, s)

// Moving normally: fixes every 150 m a minute apart are not stops.
s = stopsOf([0, 1, 2, 3, 4, 5].map(i => at(i, i * 150)))
ok('steady driving makes no stops', s.length === 0, s)

// Next fix 5 km away after a long gap: the car moved without reporting.
s = stopsOf([at(0, 0), at(50, 5000)])
ok('far departure fix is a gap, not a stop', s.length === 0, s)

// On a fare, a long wait is not a stop (the ride cadence shows slow movement).
s = stopsOf([at(0, 0, 'r1'), at(10, 20, 'r1'), at(20, 400, 'r1')])
ok('fares never produce stops', s.length === 0, s)

// A stop never runs past the end of its shift.
s = stopsOf([at(0, 0), at(120, 200)], [{ from: min(-30), to: min(30) }, { from: min(110), to: null }])
ok('capped at shift end', s[0].to === min(30) && s[0].minutes === 30, s)
ok('next shift parked at the new spot shows as ongoing', s.length === 2 && s[1].from === min(120) && s[1].ongoing, s)

// Last fix of the day in an OPEN shift: parked there right now.
s = stopsOf([at(0, 0), at(4, 300)], [{ from: min(-10), to: null }], min(40))
ok('still parked now in an open shift', s.length === 1 && s[0].from === min(4) && s[0].to === min(40) && s[0].ongoing, s)

// Last fix of the day, shift ended later: parked until the shift ended.
s = stopsOf([at(0, 0)], [{ from: min(-10), to: min(25) }])
ok('last fix runs to shift end', s.length === 1 && s[0].to === min(25) && !s[0].ongoing, s)

// No shift data (days before the shift log): last fix makes no invented stop.
s = stopsOf([at(0, 0)])
ok('no shift data, no invented stop', s.length === 0, s)

// Short pause at a light: under 5 minutes is not a stop.
s = stopsOf([at(0, 0), at(3, 200)])
ok('3-minute pause is not a stop', s.length === 0, s)

// Multi-fix run (jitter) still works, extended to departure.
s = stopsOf([at(0, 0), at(10, 10), at(20, 5), at(30, 250)])
ok('jittery run extends to departure', s.length === 1 && s[0].from === min(0) && s[0].to === min(30), s)

console.log(`${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
