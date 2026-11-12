import { expect } from 'chai';
import {
  getEidSources,
  getRequestParams,
  logEvent,
  MAX_BATCH_BYTES,
  NO_EIDS,
  send,
  sendBatch,
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

describe('newsCorpAnalyticsAdapter sendOnPageHide', function () {
  const endpoint = 'https://collector.example.test/pb/';
  let clock, beacon, googletagBefore, visibility, xhrs;

  // utils.ajax uses window.XMLHttpRequest directly; record what it sends.
  class RecordingXhr {
    open(method, url) { Object.assign(this, { method, url }); }
    setRequestHeader() {}
    send(body) { this.requestBody = body; xhrs.push(this); }
  }

  function auction(auctionId, bidders = ['appnexus', 'rubicon']) {
    logEvent({ eventType: 'auctionInit', data: { auctionId, timestamp: 1, timeout: 1500 } });
    logEvent({
      eventType: 'bidRequested',
      data: {
        auctionId,
        start: 2,
        bids: bidders.map((bidder, i) => ({ adUnitCode: 'div-1', bidId: `${auctionId}-${i}`, bidder, params: {} })),
      },
    });
    sendBatch();
  }

  function hidePage() {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
  }

  function collectorRequests() {
    return xhrs.filter((r) => r.url === endpoint);
  }

  beforeEach(function () {
    googletagBefore = window.googletag;
    window.googletag = { pubads: () => ({ getSlots: () => [] }) };
    clock = sinon.useFakeTimers();
    beacon = sinon.stub(navigator, 'sendBeacon').returns(true);
    visibility = 'visible';
    sinon.stub(document, 'visibilityState').get(() => visibility);
    xhrs = [];
    sinon.stub(window, 'XMLHttpRequest').value(RecordingXhr);
  });
  afterEach(function () {
    send(); // leave no queued events for the next test
    setEndPoint({ options: {} });
    sinon.restore();
    clock.restore();
    window.googletag = googletagBefore;
  });

  it('is off by default: one XHR per burst of events, 100 ms after it', function () {
    setEndPoint({ options: { endpoint } });
    auction('a1');
    expect(collectorRequests()).to.have.length(0);
    clock.tick(100);
    expect(collectorRequests()).to.have.length(1);
    hidePage();
    expect(beacon.called).to.equal(false);
  });

  it('holds every auction until the page is hidden, then sends one beacon', function () {
    setEndPoint({ options: { endpoint, sendOnPageHide: true } });
    auction('a1');
    clock.tick(5000);
    auction('a2');
    clock.tick(5000);
    expect(collectorRequests()).to.have.length(0);
    expect(beacon.called).to.equal(false);

    hidePage();
    expect(beacon.calledOnce).to.equal(true);
    expect(beacon.firstCall.args[0]).to.equal(endpoint);
    expect(beacon.firstCall.args[1]).to.be.instanceOf(Blob);
    expect(beacon.firstCall.args[1].type).to.contain('text/plain');
    expect(collectorRequests()).to.have.length(0);

    // Nothing queued: hiding again or unloading sends nothing more.
    hidePage();
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon.calledOnce).to.equal(true);
  });

  it('sends on pagehide when the page was not hidden first', function () {
    setEndPoint({ options: { endpoint, sendOnPageHide: true } });
    auction('a1');
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon.calledOnce).to.equal(true);
  });

  it('falls back to XHR when sendBeacon refuses the payload', function () {
    beacon.returns(false);
    setEndPoint({ options: { endpoint, sendOnPageHide: true } });
    auction('a1');
    hidePage();
    expect(beacon.calledOnce).to.equal(true);
    expect(collectorRequests()).to.have.length(1);
  });

  it('sends early by XHR once the batch nears the sendBeacon size limit', function () {
    setEndPoint({ options: { endpoint, sendOnPageHide: true } });
    const bidders = Array.from({ length: 40 }, (_, i) => `bidder${i}`);
    let n = 0;
    while (collectorRequests().length === 0 && n < 200) {
      auction(`big-${n++}`, bidders);
    }
    expect(collectorRequests()).to.have.length(1);
    expect(beacon.called).to.equal(false);
    const sentBytes = collectorRequests()[0].requestBody.byteLength;
    expect(sentBytes).to.be.at.least(MAX_BATCH_BYTES);
    expect(sentBytes).to.be.below(64 * 1024);
  });

  it('sends the held batch when an auction starts on a new URL', function () {
    const before = window.location.href;
    setEndPoint({ options: { endpoint, sendOnPageHide: true } });
    try {
      auction('a1');
      window.history.pushState({}, '', '?spa-route=2');
      auction('a2');
      expect(collectorRequests()).to.have.length(1);
    } finally {
      window.history.replaceState({}, '', before);
    }
    hidePage();
    expect(beacon.calledOnce).to.equal(true);
  });
});
