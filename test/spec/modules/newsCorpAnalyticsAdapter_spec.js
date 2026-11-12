import { expect } from 'chai';
import ProtoBuf from 'protobufjs';
import protoSpec from 'modules/NewsCorpPrebidAnalytics/log-prebid-events-newsiq.json';
import { auctionBytes, encodePayload } from 'modules/NewsCorpPrebidAnalytics/encoder.js';
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

describe('newsCorpAnalyticsAdapter encoder', function () {
  const Builder = ProtoBuf.loadJson(protoSpec);
  const Payload = Builder.build('LogPrebidEventsNewsIQ');

  function protobufjsBytes(payload) {
    return Array.from(new Uint8Array(new Payload(payload).toArrayBuffer()));
  }

  function bytes(payload) {
    return Array.from(encodePayload(payload));
  }

  const realistic = {
    timestamp: 1794500000123,
    referer_url: 'https://www.realtor.com/realestateandhomes-search/Austin_TX?view=map',
    domain: 'RDC_X',
    device: 'desktop',
    platform: 'Prebid Web',
    seller_member_id: 7463,
    auctions: [
      {
        auction_init_timestamp: 1794500000001,
        prebid_auction_id: '1f0c8f9e-2b1a-4c3d-9e8f-0a1b2c3d4e5f',
        configured_timeout_ms: 1500,
        version: 'v11.47.0',
        msg_type: 101,
      },
      {
        msg_type: 102,
        prebid_auction_id: '1f0c8f9e-2b1a-4c3d-9e8f-0a1b2c3d4e5f',
        ad_units: [
          {
            ad_unit_code: 'div-gpt-ad-1',
            bids: [{ bid_id: '3a1b2c', bidder_code: 'rubicon', request_timestamp: 1794500000010 }],
            params: [
              { key: 'ad unit', value: '/7690/rdc.srp/top' },
              { key: 'accountId', value: '12345' },
              { key: 'requestId', value: '3a1b2c' },
              { key: 'eids', value: 'adserver.org,liveramp.com' },
            ],
          },
        ],
      },
      {
        msg_type: 103,
        prebid_auction_id: '1f0c8f9e-2b1a-4c3d-9e8f-0a1b2c3d4e5f',
        ad_units: [
          {
            ad_unit_code: 'div-gpt-ad-1',
            bids: [
              {
                bid_id: '7d8e9f',
                bidder_code: 'rubicon',
                price: 1.2345,
                status_code: 9,
                bidder_ad_unit_id: 'div-gpt-ad-1',
                request_timestamp: 1794500000010,
                response_timestamp: 1794500000418,
                creative: { creative_id: 'cr-42', width: 300, height: 250, brand: undefined },
                source: 'client',
              },
            ],
            params: [{ key: 'hb_pb', value: '1.20' }],
          },
        ],
      },
      {
        msg_type: 104,
        prebid_auction_id: '1f0c8f9e',
        ad_units: [{ ad_unit_code: 'div-2', bids: [{ bid_id: 'x', bidder_code: 'criteo', status_code: 13 }], params: [] }],
      },
    ],
  };

  it('matches protobufjs byte for byte on a realistic payload', function () {
    expect(bytes(realistic)).to.deep.equal(protobufjsBytes(realistic));
  });

  it('matches protobufjs on edge values', function () {
    const edge = {
      timestamp: 0,
      referer_url: 'https://example.test/é/日本/😀',
      seller_member_id: 4294967295,
      domain: '',
      auctions: [
        // eslint-disable-next-line no-new-wrappers
        { msg_type: 0, configured_timeout_ms: -1, auction_init_timestamp: 2 ** 53 - 1, version: new String('v') },
        { msg_type: 127, configured_timeout_ms: 128, auction_init_timestamp: 1.9 },
        { msg_type: 16384, auction_init_timestamp: -5, ad_units: [] },
        { auction_init_timestamp: NaN, ad_units: [{ bids: [{ price: 0 }, { price: -0.5 }, { price: NaN }] }] },
        { auction_init_timestamp: Infinity, ad_units: [{ bids: [{ creative: {} }], params: [{}] }] },
        { auction_init_timestamp: 2 ** 64 },
        { prebid_auction_id: null, version: undefined },
      ],
    };
    expect(bytes(edge)).to.deep.equal(protobufjsBytes(edge));
  });

  it('matches protobufjs on random payloads', function () {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const maybe = (fn) => (rand() < 0.3 ? undefined : fn());
    const int = (max) => Math.floor(rand() * max);
    const str = () => Array.from({ length: int(40) }, () => String.fromCharCode(int(rand() < 0.9 ? 128 : 0x3000))).join('');
    const ts = () => 1700000000000 + int(1e11);
    const bid = () => ({
      bid_id: maybe(str),
      price: maybe(() => rand() * 50),
      bidder_code: maybe(str),
      bidder_ad_unit_id: maybe(str),
      request_timestamp: maybe(ts),
      response_timestamp: maybe(ts),
      status_code: maybe(() => int(20)),
      source: maybe(str),
      creative: maybe(() => ({ creative_id: maybe(str), width: maybe(() => int(2000)), height: maybe(() => int(2000)) })),
    });
    const adUnit = () => ({
      ad_unit_code: maybe(str),
      bids: Array.from({ length: int(4) }, bid),
      params: Array.from({ length: int(6) }, () => ({ key: maybe(str), value: maybe(str) })),
    });
    for (let i = 0; i < 200; i++) {
      const payload = {
        timestamp: maybe(ts),
        referer_url: maybe(str),
        seller_member_id: maybe(() => int(1e6)),
        domain: maybe(str),
        device: maybe(str),
        platform: maybe(str),
        auctions: Array.from({ length: int(5) }, () => ({
          version: maybe(str),
          auction_init_timestamp: maybe(ts),
          prebid_auction_id: maybe(str),
          configured_timeout_ms: maybe(() => int(5000)),
          msg_type: maybe(() => 101 + int(7)),
          ad_units: Array.from({ length: int(3) }, adUnit),
        })),
      };
      expect(bytes(payload), `payload ${i}`).to.deep.equal(protobufjsBytes(payload));
    }
  });

  it('skips a bad field where protobufjs would throw and lose the batch', function () {
    const bad = {
      timestamp: 5,
      seller_member_id: '7463',
      unknown_key: 'x',
      auctions: [{ msg_type: 103, configured_timeout_ms: 1.5, ad_units: [{ bids: [{ price: '1.20', bid_id: 'b1', creative: { height: '' } }] }] }],
    };
    expect(() => new Payload(bad).toArrayBuffer()).to.throw();
    const decoded = Payload.decode(encodePayload(bad));
    expect(decoded.seller_member_id).to.equal(null);
    expect(decoded.auctions[0].msg_type).to.equal(103);
    expect(decoded.auctions[0].configured_timeout_ms).to.equal(null);
    expect(decoded.auctions[0].ad_units[0].bids[0].price).to.equal(null);
    expect(decoded.auctions[0].ad_units[0].bids[0].bid_id).to.equal('b1');
  });

  it('auctionBytes is the size protobufjs calculates for an Auction', function () {
    realistic.auctions.forEach((auction) => {
      expect(auctionBytes(auction)).to.equal(new Payload.Auction(auction).calculate());
    });
  });
});

describe('newsCorpAnalyticsAdapter includeNoBids', function () {
  const endpoint = 'https://collector.example.test/pb/';
  const Payload = ProtoBuf.loadJson(protoSpec).build('LogPrebidEventsNewsIQ');
  let clock, googletagBefore, xhrs;

  class RecordingXhr {
    open(method, url) { Object.assign(this, { method, url }); }
    setRequestHeader() {}
    send(body) { this.requestBody = body; xhrs.push(this); }
  }

  function noBid(bidId, auctionId = 'nb-auction') {
    logEvent({
      eventType: 'noBid',
      data: { auctionId, adUnitCode: 'div-1', bidId, bidder: 'criteo', requestTimestamp: 1000, responseTimestamp: 1234 },
    });
  }

  function sentAuctions() {
    send();
    return xhrs
      .filter((r) => r.url === endpoint)
      .flatMap((r) => Payload.decode(r.requestBody).auctions);
  }

  beforeEach(function () {
    googletagBefore = window.googletag;
    window.googletag = { pubads: () => ({ getSlots: () => [] }) };
    clock = sinon.useFakeTimers();
    xhrs = [];
    sinon.stub(window, 'XMLHttpRequest').value(RecordingXhr);
  });
  afterEach(function () {
    send();
    setEndPoint({ options: {} });
    sinon.restore();
    clock.restore();
    window.googletag = googletagBefore;
  });

  it('sends nothing for noBid by default', function () {
    setEndPoint({ options: { endpoint } });
    noBid('nb-off');
    expect(sentAuctions()).to.have.length(0);
  });

  it('sends a Bid_No_Bid message with the response time when the option is on', function () {
    setEndPoint({ options: { endpoint, includeNoBids: true } });
    noBid('nb-1');
    const auctions = sentAuctions();
    expect(auctions).to.have.length(1);
    expect(auctions[0].msg_type).to.equal(107);
    expect(auctions[0].prebid_auction_id).to.equal('nb-auction');
    const unit = auctions[0].ad_units[0];
    expect(unit.ad_unit_code).to.equal('div-1');
    expect(unit.bids[0].bid_id).to.equal('nb-1');
    expect(unit.bids[0].bidder_code).to.equal('criteo');
    expect(unit.bids[0].status_code).to.equal(12);
    expect(unit.bids[0].request_timestamp.toNumber()).to.equal(1000);
    expect(unit.bids[0].response_timestamp.toNumber()).to.equal(1234);
  });

  it('skips a noBid for a bid already sent as timed out', function () {
    setEndPoint({ options: { endpoint, includeNoBids: true } });
    logEvent({
      eventType: 'bidTimeout',
      data: [{ auctionId: 'nb-auction', adUnitCode: 'div-1', bidId: 'late-1', bidder: 'criteo' }],
    });
    noBid('late-1');
    noBid('other-1');
    const types = sentAuctions().map((a) => [a.msg_type, a.ad_units[0].bids[0].bid_id]);
    expect(types).to.deep.equal([[104, 'late-1'], [107, 'other-1']]);
  });
});
