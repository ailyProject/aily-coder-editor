import assert from 'node:assert/strict'
import test from 'node:test'
import { checkArduinoDependencies, parseArduinoDependencies, satisfiesArduinoVersion } from './arduinoLibraryDependencies.js'

test('Arduino named dependencies retain spaces and boolean version constraints', () => {
  assert.deepEqual(parseArduinoDependencies('Adafruit Unified Sensor, Client (>=1.0.0 && (<2.0.0 || =3.0.0))'), [
    { name: 'Adafruit Unified Sensor', constraint: '' },
    { name: 'Client', constraint: '>=1.0.0 && (<2.0.0 || =3.0.0)' },
  ])
  for (const [version, range, expected] of [
    ['1.5.0', '>=1.0.0 && <2.0.0', true], ['2.0.0', '>=1.0.0 && <2.0.0', false],
    ['3.0.0', '(>=1.0.0 && <2.0.0) || =3.0.0', true], ['1.0.0', '!=1.0.0', false],
    ['1.0.1', '!(=1.0.0)', true], ['1.2', '=1.2.0', true], ['1.2.0-beta.1', '<1.2.0', true],
    ['1.0.0', '=1.0.0 trailing', null], ['1.0.0', '>=1.0.0 ||', null], ['unknown', '>=1.0.0', null],
    ['1.0.0', '(>=1.0.0', null], ['1.0.0', '>=1.0.0 &&)', null],
  ]) assert.equal(satisfiesArduinoVersion(version, range), expected, `${version} ${range}`)
})

test('readiness checks the transitive graph, cycles, missing, version and ambiguous identities', () => {
  const library = (root, name, version, depends = '') => ({ root, name, version, dependencies: parseArduinoDependencies(depends) })
  const a = library('/a', 'Driver', '1.0.0', 'Sensor (>=2.0.0)')
  const b = library('/b', 'Sensor', '2.1.0', 'Driver')
  assert.equal(checkArduinoDependencies(['/a'], [a, b]).dependenciesReady, true)
  assert.equal(checkArduinoDependencies(['/a'], [a]).dependencyIssues[0].reason, 'missing')
  assert.equal(checkArduinoDependencies(['/a'], [a, { ...b, version: '1.0.0' }]).dependencyIssues[0].reason, 'version-mismatch')
  assert.equal(checkArduinoDependencies(['/a'], [a, b, { ...b, root: '/b2' }]).dependencyIssues[0].reason, 'ambiguous')
  assert.equal(checkArduinoDependencies(['/a'], [a, { ...b, dependencies: parseArduinoDependencies('Bus') }]).dependencyIssues[0].name, 'Bus')
  assert.equal(checkArduinoDependencies(['/legacy'], []).dependencyStatus, 'unknown')
  assert.equal(checkArduinoDependencies(['/a'], [a, b, library('/unrelated', 'Other', '1.0.0', 'Missing')]).dependenciesReady, true)
})
