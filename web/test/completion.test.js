import assert from 'node:assert/strict'
import test from 'node:test'
import { complete } from '../completion.js'

const files = ['README.txt', 'app.log', 'apps/', 'notes.md']

test('a unique command completes with a trailing space', () => {
  assert.deepEqual(complete('gre', files), ['p '])
  assert.deepEqual(complete('ls | gre', files), ['p '])
  assert.deepEqual(complete('cd /tmp; ech', files), ['o '])
})

test('several matching commands are listed', () => {
  assert.deepEqual(complete('h', files), ['head', 'help', 'history'])
})

test('arguments complete against files, directories without a space', () => {
  assert.deepEqual(complete('cat REA', files), ['DME.txt '])
  assert.deepEqual(complete('cat app', files), ['app.log', 'apps/'])
  assert.deepEqual(complete('cd apps', files), ['/'])
})

test('nothing completes after characters the shell would treat specially', () => {
  assert.deepEqual(complete('echo "RE', files), [])
  assert.deepEqual(complete('cat zzz', files), [])
})
