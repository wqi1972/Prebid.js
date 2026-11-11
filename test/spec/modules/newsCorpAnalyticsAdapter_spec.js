import { expect } from 'chai';
import {
  getEidSources,
  getRequestParams,
  NO_EIDS,
  setEndPoint,
} from 'modules/NewsCorpPrebidAnalytics/analytics.js';

describe('newsCorpAnalyticsAdapter user ID sources', function () {
  const eids = [
    { source: 'uidapi.com', uids: [{ id: 'SECRET-UID2', atype: 3 }] },
    { source: 'liveramp.com', uids: [{ id: 'SECRET-ENVELOPE', atype: 3 }] },
    { source: 'adserver.org', uids: [{ id: 'SECRET-TDID', atype: 1 }] },
    { source: 'liveramp.com', uids: [{ id: 'SECRET-PAIR', atype: 571187 }] },
  ];

  let googletagBefore;
  beforeEach(function () {
    googletagBefore = window.googletag;
    window.googletag = { pubads: () => ({ getSlots: () => [] }) };
  });
  afterEach(function () {
    window.googletag = googletagBefore;
    setEndPoint({ options: {} });
  });

  function eidsParam(params) {
    return params.filter((p) => p.key === 'eids');
  }

  describe('getEidSources', function () {
    it('returns sorted, unique sources and never the identifiers', function () {
      const value = getEidSources({ userIdAsEids: eids });
      expect(value).to.equal('adserver.org,liveramp.com,uidapi.com');
      expect(value).to.not.contain('SECRET');
    });

    it('falls back to the bidder request ortb2 EIDs', function () {
      const bidderRequest = { ortb2: { user: { ext: { eids } } } };
      expect(getEidSources({}, bidderRequest)).to.equal('adserver.org,liveramp.com,uidapi.com');
    });

    it('returns NO_EIDS when there are no usable sources', function () {
      expect(getEidSources({})).to.equal(NO_EIDS);
      expect(getEidSources({ userIdAsEids: [] }, { ortb2: {} })).to.equal(NO_EIDS);
      expect(getEidSources({ userIdAsEids: [{ uids: [] }, { source: '' }] })).to.equal(NO_EIDS);
    });
  });

  describe('getRequestParams', function () {
    const bid = { adUnitCode: 'div-1', bidId: 'b1', params: { siteId: '1' }, userIdAsEids: eids };

    it('does not send eids by default', function () {
      setEndPoint({ options: { endpoint: 'https://example.test/pb/' } });
      expect(eidsParam(getRequestParams(bid, {}))).to.have.length(0);
    });

    it('does not send eids unless includeUserIds is exactly true', function () {
      setEndPoint({ options: { includeUserIds: 'true' } });
      expect(eidsParam(getRequestParams(bid, {}))).to.have.length(0);
    });

    it('sends the EID sources when includeUserIds is true', function () {
      setEndPoint({ options: { includeUserIds: true } });
      expect(eidsParam(getRequestParams(bid, {}))).to.deep.equal([
        { key: 'eids', value: 'adserver.org,liveramp.com,uidapi.com' },
      ]);
    });

    it('sends NO_EIDS when the option is on and the bidder got no IDs', function () {
      setEndPoint({ options: { includeUserIds: true } });
      const noIds = { adUnitCode: 'div-1', bidId: 'b2' };
      expect(eidsParam(getRequestParams(noIds, {}))).to.deep.equal([{ key: 'eids', value: NO_EIDS }]);
    });

    it('turns off again when analytics is re-enabled without the option', function () {
      setEndPoint({ options: { includeUserIds: true } });
      setEndPoint({ options: {} });
      expect(eidsParam(getRequestParams(bid, {}))).to.have.length(0);
    });
  });
});
