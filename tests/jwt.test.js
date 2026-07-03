import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { decodeJwtExp } = await import('../src/utils/jwt.js');

function makeJwt(claims) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;
}

describe('decodeJwtExp', () => {
  it('reads exp from a valid token', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(decodeJwtExp(makeJwt({ sub: 'org-1', exp })), exp);
  });

  it('returns null when the token has no exp claim', () => {
    assert.equal(decodeJwtExp(makeJwt({ sub: 'org-1' })), null);
  });

  it('returns null when exp is not a number', () => {
    assert.equal(decodeJwtExp(makeJwt({ exp: 'tomorrow' })), null);
  });

  it('returns null for malformed input', () => {
    assert.equal(decodeJwtExp('not-a-jwt'), null);
    assert.equal(decodeJwtExp('a.###.b'), null);
    assert.equal(decodeJwtExp(''), null);
    assert.equal(decodeJwtExp(null), null);
    assert.equal(decodeJwtExp(undefined), null);
  });
});
