// Logic test for src/lib/driverRanking.ts. No test runner exists in this repo,
// so this transpiles the module with typescript into a temp dir and asserts.
// Run: node scripts/driver-ranking-test.cjs
const path = require('path'), fs = require('fs'), os = require('os')
const ROOT = path.resolve(__dirname, '..')
const ts = require(path.join(ROOT, 'node_modules/typescript'))
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ranking-'))
fs.mkdirSync(path.join(OUT, 'lib'))
for (const f of ['driverRanking', 'presence']) {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib', f + '.ts'), 'utf8')
  fs.writeFileSync(path.join(OUT, 'lib', f + '.js'),
    ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)
}
module.paths.unshift(path.join(ROOT, 'node_modules'))
require('module').Module._initPaths()
process.env.NODE_PATH = path.join(ROOT, 'node_modules'); require('module').Module._initPaths()
const { rankDrivers } = require(path.join(OUT, 'lib/driverRanking.js'))
const now = Date.now(), live = new Date(now - 5000).toISOString(), stale = new Date(now - 600000).toISOString()
const P = { lat: 45.0772, lng: -64.4960 }
const mk = (id, km, extra = {}) => ({ id, seats: 4, wheelchair_accessible: false, vehicle_class_id: null, is_active: true, last_seen_at: live, push_token: 'ExponentPushToken[x]',
  current_lat: P.lat + km / 111, current_lng: P.lng, profile: { name: id }, ...extra })
let pass = 0, fail = 0
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + JSON.stringify(d))) }
const ids = r => r.ranked.map(x => x.driver.id + (x.demoted ? '*' : ''))
const classes = [{ id: 'van', capacity: 7, restricted: false }]

const drivers = [mk('far', 9), mk('near', 1), mk('awayNear', 0.5, { last_seen_at: stale }), mk('busy', 0.2), mk('off', 0.1, { is_active: false }),
  mk('gone', 0.1, { profile: { name: 'gone', deleted_at: '2026-01-01' } })]
const busy = new Set(['busy'])
let r = rankDrivers({ ride: { ...P.lat && { pickup_lat: P.lat, pickup_lng: P.lng } }, drivers, busyDriverIds: busy, vehicleClasses: [], now })
ok('immediate: near, far, then away demoted; busy/off/deleted excluded', JSON.stringify(ids(r)) === JSON.stringify(['near', 'far', 'awayNear*']), ids(r))
ok('immediate: closest flagged on near', r.ranked[0].closest && !r.ranked[1].closest)
ok('immediate: approx distance', r.ranked[0].distance.kind === 'approx' && Math.abs(r.ranked[0].distance.km - 1) < 0.1, r.ranked[0].distance)

r = rankDrivers({ ride: { pickup_lat: P.lat, pickup_lng: P.lng }, drivers, busyDriverIds: busy, vehicleClasses: [], now,
  drive: new Map([['far', { mins: 4, km: 9.5 }], ['near', { mins: 7, km: 1.4 }]]) })
ok('drive times override straight line', ids(r)[0] === 'far' && r.ranked[0].distance.kind === 'drive', ids(r))

r = rankDrivers({ ride: { pickup_lat: P.lat, pickup_lng: P.lng, declined_by: ['near'] }, drivers, busyDriverIds: busy, vehicleClasses: [], now,
  conflicts: new Map([['far', { misses: true, commitment_at: new Date(now + 3600e3).toISOString(), minutes_short: 6 }]]) })
ok('declined + clash demoted, nobody closest', r.ranked.every(x => x.demoted) && !r.ranked.some(x => x.closest), ids(r))

const tomorrow = new Date(now + 20 * 3600e3).toISOString()
r = rankDrivers({ ride: { pickup_lat: P.lat, pickup_lng: P.lng, scheduled_at: tomorrow }, drivers, busyDriverIds: busy, vehicleClasses: [], now })
const by = Object.fromEntries(r.ranked.map(x => [x.driver.id, x]))
ok('later: whole roster minus deleted', r.ranked.length === 5 && !by.gone, ids(r))
ok('later: off shift not demoted, ranked after on-shift, no km', !by.off.demoted && by.off.distance === null && ids(r).indexOf('off') === 4, ids(r))
ok('later: busy-now not an issue tomorrow', by.busy.issues.length === 0 && !by.busy.demoted, by.busy.issues)
ok('later: away not an issue tomorrow', !by.awayNear.demoted, by.awayNear.issues)
ok('later: distance is a "now" hint, no closest', by.near.distance.kind === 'now' && !r.ranked.some(x => x.closest))

const soonSched = new Date(now + 40 * 60e3).toISOString()
r = rankDrivers({ ride: { pickup_lat: P.lat, pickup_lng: P.lng, scheduled_at: soonSched }, drivers, busyDriverIds: busy, vehicleClasses: [], now })
const s2 = Object.fromEntries(r.ranked.map(x => [x.driver.id, x]))
ok('soon scheduled: off shift + on ride demoted', s2.off.demoted && s2.busy.demoted && s2.busy.issues.includes('onRide'), ids(r))

r = rankDrivers({ ride: { pickup_lat: P.lat, pickup_lng: P.lng, vehicle_class_id: 'van' }, drivers: [mk('sedan', 1), mk('van', 5, { seats: 7 })], busyDriverIds: new Set(), vehicleClasses: classes, now })
ok('vehicle: 7-seat ride puts van first, sedan demoted', JSON.stringify(ids(r)) === JSON.stringify(['van', 'sedan*']), ids(r))
r = rankDrivers({ ride: { pickup_lat: P.lat, pickup_lng: P.lng, requires_wheelchair: true }, drivers: [mk('plain', 1), mk('ramp', 5, { wheelchair_accessible: true })], busyDriverIds: new Set(), vehicleClasses: [], now })
ok('wheelchair: ramp first', ids(r)[0] === 'ramp' && r.ranked[1].issues.includes('vehicle'), ids(r))
r = rankDrivers({ ride: { pickup_lat: null, pickup_lng: null }, drivers: [mk('a', 1)], busyDriverIds: new Set(), vehicleClasses: [], now })
ok('no pickup yet: no distance, no crash', r.ranked[0].distance === null)
r = rankDrivers({ ride: { pickup_lat: P.lat, pickup_lng: P.lng }, drivers: [mk('seeded', 0.1, { push_token: null, last_seen_at: null }), mk('real', 3)], busyDriverIds: new Set(), vehicleClasses: [], now })
ok('soon: tokenless seeded driver demoted, real one is Closest', JSON.stringify(ids(r)) === JSON.stringify(['real', 'seeded*']) && r.ranked[0].closest && r.ranked[1].issues.includes('unreachable'), ids(r))
r = rankDrivers({ ride: { pickup_lat: P.lat, pickup_lng: P.lng, scheduled_at: tomorrow }, drivers: [mk('notok', 0.1, { push_token: null })], busyDriverIds: new Set(), vehicleClasses: [], now })
ok('later: tokenless labelled, not demoted', !r.ranked[0].demoted && r.ranked[0].issues.includes('unreachable'))
r = rankDrivers({ ride: { pickup_lat: P.lat, pickup_lng: P.lng, scheduled_at: tomorrow, driver_id: 'near' }, drivers, busyDriverIds: busy, vehicleClasses: [], now })
ok('current driver flagged', r.ranked.find(x => x.driver.id === 'near').current && r.ranked.filter(x => x.current).length === 1)
console.log(`${pass} pass, ${fail} fail`)
if (fail) process.exit(1)
