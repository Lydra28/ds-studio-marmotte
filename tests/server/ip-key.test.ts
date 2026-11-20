import assert from 'node:assert/strict';
import test from 'node:test';
import { ipKey, UNKNOWN_IP } from '../../server/ip-key.js';

// Audit du 2026-11-18, n° 2 : clé de comptage des plafonds par IP.
test('ipKey : IPv6 par /64, forme normalisée ; IPv4 et IPv4 mappée à l’adresse', () => {
  const net = '2001:db8:1:2::/64';
  for (const ip of ['2001:db8:1:2::1', '2001:DB8:1:2:abcd:ef01:2345:6789', '2001:0db8:0001:0002:0:0:0:ffff', ' 2001:db8:1:2:: ', '2001:db8:1:2::1%eth0'])
    assert.equal(ipKey(ip), net, ip);
  assert.equal(ipKey('2001:db8:1:3::1'), '2001:db8:1:3::/64', '/64 voisin compté à part');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('fe80::1:2:3:4'), 'fe80:0:0:0::/64');
  assert.equal(ipKey('2001:db8:1:2:3:4:1.2.3.4'), net, 'IPv4 en fin de groupe');

  assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('::FFFF:CB00:7109'), '203.0.113.9', 'mappée en hexadécimal');
  assert.equal(ipKey('0:0:0:0:0:ffff:203.0.113.9'), '203.0.113.9');

  for (const bad of [undefined, null, '', 'inconnue', 'pas-une-ip', '1.2.3', '2001:db8::1::2', `x${Math.random()}`])
    assert.equal(ipKey(bad), UNKNOWN_IP, String(bad));
});
