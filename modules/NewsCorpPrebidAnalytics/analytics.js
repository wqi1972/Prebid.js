import { ajax, debounce } from "./utils";
import { detectDeviceType } from "./device-detection";
// Encodes log-prebid-events-newsiq.proto; byte-identical to protobufjs v5.
import { auctionBytes, encodePayload } from "./encoder.js";

//const url = 'https://rb.adnxs.com/pack?log=log_prebid_events&format=protobuf';
let NewsIQUrlProduction = "https://log.ncaudienceexchange.com/pb/"; // production analytics end point
let NewsIQUrlTest = "https://newscorp-newsiq-dev.appspot.com/pb/"; // test analytics end point
let memberId = undefined;
// When true, each bid request carries an `eids` param listing the user ID
// sources (EID `source` values) the bidder received. Only the source names
// are sent, never the identifiers. Off by default.
let includeUserIds = false;
// When true, events are held and sent in one request when the page is hidden
// or unloaded (navigator.sendBeacon), instead of one request per burst of
// events. A batch is sent early, by XHR, when it nears MAX_BATCH_BYTES or when
// an auction starts on a new URL (single-page navigation). Off by default.
let sendOnPageHide = false;
// When true, a bid request the bidder answered without a bid is sent as a
// Bid_No_Bid message (with its response time), so no-bids are counted directly
// instead of as requests minus responses minus timeouts. Off by default.
let includeNoBids = false;
// Bid request ids already sent as timed out: Prebid can still emit noBid for
// them when the bidder finishes after the auction timeout.
const timedOutBidIds = new Set();
// sendBeacon refuses payloads over 64 KB (a quota shared by the page's
// pending beacons), so flush before that.
export const MAX_BATCH_BYTES = 48 * 1024;
let queueBytes = 0;
let pageHideListenersAdded = false;
const LIMIT = 100;
const debouncedSend = debounce(() => send(), LIMIT);

/**
 * Called after every event. Debounced send by default; with sendOnPageHide,
 * sends only when the batch is near MAX_BATCH_BYTES.
 */
export function sendBatch() {
  if (!sendOnPageHide) {
    debouncedSend();
    return;
  }
  if (queueBytes >= MAX_BATCH_BYTES) {
    send();
  }
}

function addPageHideListeners() {
  if (pageHideListenersAdded) return;
  pageHideListenersAdded = true;
  // visibilitychange to hidden is the last event mobile browsers reliably
  // fire; pagehide covers desktop unloads that skip it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") send(true);
  });
  window.addEventListener("pagehide", () => send(true));
}

/** Encoded size of one queued message, for the batch size limit. */
function messageBytes(log) {
  try {
    return auctionBytes(log);
  } catch (e) {
    return 1024;
  }
}

function enqueue(messages) {
  messages.forEach((log) => {
    _queue.push(log);
    if (sendOnPageHide) queueBytes += messageBytes(log);
  });
}

export function setEndPoint(config) {
  if (config && config.options && config.options.endpoint) {
    NewsIQUrlProduction = config.options.endpoint;
    NewsIQUrlTest = config.options.endpoint;
  }
  if (config && config.options && config.options.memberId) {
    memberId = config.options.memberId;
  }
  includeUserIds = !!(config && config.options && config.options.includeUserIds === true);
  sendOnPageHide = !!(config && config.options && config.options.sendOnPageHide === true);
  includeNoBids = !!(config && config.options && config.options.includeNoBids === true);
  if (sendOnPageHide) addPageHideListeners();
}

// Value of the `eids` param when the option is on but the bidder got no IDs,
// so "no user ID" can be told apart from "option off" (param absent).
export const NO_EIDS = "none";

/**
 * Sorted, de-duplicated EID sources a bid request carries, joined with ",",
 * e.g. "adserver.org,liveramp.com,uidapi.com". NO_EIDS when there are none.
 * Identifier values are never read into the result.
 */
export function getEidSources(bid, bidderRequest) {
  let eids = bid && bid.userIdAsEids;
  if (!Array.isArray(eids) || eids.length === 0) {
    eids = bidderRequest?.ortb2?.user?.ext?.eids;
  }
  if (!Array.isArray(eids)) {
    return NO_EIDS;
  }
  const sources = [];
  eids.forEach((eid) => {
    const source = eid && eid.source;
    if (isString(source) && source && sources.indexOf(source) === -1) {
      sources.push(source);
    }
  });
  return sources.length ? sources.sort().join(",") : NO_EIDS;
}

const STATUS = {
  BID_RECEIVED: 9,
  BID_WON: 10,
  BID_LOST: 11,
  NO_BID: 12,
  BID_TIMEOUT: 13,
};

const MSG_TYPE = {
  Auction_Init: 101,
  Bid_Requested: 102,
  Bid_Response: 103,
  Bid_Timeout: 104,
  Bid_Won: 105,
  Bid_Lost: 106,
  Bid_No_Bid: 107,
};

let _topLevel = {};
let _queue = [];
let _sent = [];

function logMessage() {
  if (pbjs.getConfig("debug")) {
    window.console.log.apply(null, arguments);
  }
}

function isDebugDetail() {
  var search = window.location.search.toLowerCase();
  return search.indexOf("pbjs_debug=details") !== -1;
}

/**
 * Construct analytics payload and send to endpoint.
 * @param {boolean} useBeacon Send with navigator.sendBeacon (page is hiding);
 *   falls back to XHR when it is missing or refuses the payload.
 */
export function send(useBeacon) {
  /*
  const analytics = Object.assign({}, _topLevel, {
    timestamp: Math.floor(Date.now() / 1000),
    auctions: _queue.map(log => new Auction(log))
  });
  const payload = new Analytics(analytics).toArrayBuffer();
  */
  if (_queue.length === 0) return;

  const analyticsNewsIQ = Object.assign({}, _topLevel, {
    timestamp: Date.now(),
    auctions: _queue,
  });

  const payloadNewsIQ = encodePayload(analyticsNewsIQ);

  let NewsIQUrl = NewsIQUrlProduction;
  if (isDebugDetail()) {
    NewsIQUrl = NewsIQUrlTest;
  }

  logMessage(
    "NewsCorp analytics message:",
    analyticsNewsIQ,
    "endpoint",
    NewsIQUrl
  );

  //ajax(url, payload, result => logMessage('Sent Prebid Analytics:', result));
  let beaconQueued = false;
  // ajax.js has no beacon transport, and XHR is not reliable while the page
  // is unloading.
  // eslint-disable-next-line no-restricted-properties
  if (useBeacon && navigator.sendBeacon) {
    try {
      // eslint-disable-next-line no-restricted-properties
      beaconQueued = navigator.sendBeacon(
        NewsIQUrl,
        new Blob([payloadNewsIQ], { type: "text/plain;charset=utf8" })
      );
    } catch (e) {
      beaconQueued = false;
    }
  }
  if (!beaconQueued) {
    ajax(NewsIQUrl, payloadNewsIQ, (result) =>
      logMessage("Sent NewsCorp Prebid Analytics:", result)
    );
  }

  // TODO: reconcile _sent queue with results from ajax request
  _sent = _sent.concat(_queue);
  _queue = [];
  queueBytes = 0;
}

/**
 * Dispatch event to correct handler
 */
export function logEvent({ eventType }) {
  switch (eventType) {
    case "auctionInit":
      auctionInit(...arguments);
      break;

    case "bidRequested":
      bidRequested(...arguments);
      break;

    case "bidResponse":
      bidResponse(...arguments);
      break;

    case "bidWon":
      bidWon(...arguments);
      break;

    case "bidTimeout":
      bidTimeout(...arguments);
      break;

    case "noBid":
      noBid(...arguments);
      break;
  }
}

function getDecive() {
  try {
    return detectDeviceType(window.navigator.userAgent);
  } catch {
    return "unknown";
  }
}

window.ProgrammaticBidding = window.ProgrammaticBidding || {};
window.ProgrammaticBidding.device = getDecive();

function auctionInit({ data }) {
  // A held batch shares one referer_url: send it before a new URL replaces it.
  if (sendOnPageHide && _queue.length && _topLevel.referer_url !== document.URL) {
    send();
  }
  _topLevel = {
    referer_url: document.URL,
    domain: window.ProgrammaticBidding.pageDomain || "unknown",
    device: window.ProgrammaticBidding.device,
    platform: "Prebid Web",
    seller_member_id: data.config ? data.config.memberId : memberId,
  };

  enqueue([{
    auction_init_timestamp: data.timestamp,
    prebid_auction_id: data.auctionId,
    configured_timeout_ms: data.timeout,
    version: pbjs.version,
    msg_type: MSG_TYPE.Auction_Init,
  }]);
}

function getAdUnit(adUnitId) {
  const adSlot = window.googletag
    .pubads()
    .getSlots()
    .find(function (slot) {
      return adUnitId === slot.getSlotElementId();
    });
  if (adSlot) return adSlot.getAdUnitPath();
  else return "";
}

function getBidParms(bid) {
  return [{ key: "ad unit", value: getAdUnit(bid.adUnitCode) }];
}

function isString(value) {
  return typeof value === "string" || value instanceof String;
}

function addParam(params, key, value) {
  if (value) {
    var stringVal;
    if (isString(value)) {
      stringVal = value;
    } else {
      stringVal = JSON.stringify(value);
    }
    params.push({ key: key, value: stringVal });
  }
}

export function getRequestParams(bid, bidderRequest) {
  const params = getBidParms(bid);
  if (bid.params) {
    Object.keys(bid.params).map((key) => {
      addParam(params, key, bid.params[key]);
    });
  }
  addParam(params, "requestId", bid.bidId);
  if (includeUserIds) {
    addParam(params, "eids", getEidSources(bid, bidderRequest));
  }
  return params;
}

const responseExcludeParam = [
  "ad",
  "adId",
  "adUnitCode",
  "adserverTargeting",
  "auctionId",
  "bidder",
  "bidderCode",
  "cpm",
  "creativeId",
  "currency",
  "height",
  "pbAg",
  "pbCg",
  "pbDg",
  "pbHg",
  "pbLg",
  "pbMg",
  "requestTimestamp",
  "responseTimestamp",
  "size",
  "source",
  "statusMessage",
  "width",
  "getStatusCode",
  "getSize",
  "native",
];

function getResponseParams(bid) {
  const params = getBidParms(bid);
  Object.keys(bid).map((key) => {
    if (!responseExcludeParam.includes(key)) {
      addParam(params, key, bid[key]);
    }
  });
  if (bid.adserverTargeting) {
    addParam(params, "hb_pb", bid.adserverTargeting.hb_pb);
  }
  return params;
}

function bidRequested({ data }) {
  enqueue([{
    msg_type: MSG_TYPE.Bid_Requested,
    prebid_auction_id: data.auctionId,
    ad_units: data.bids.map((bid) => {
      return {
        ad_unit_code: bid.adUnitCode,
        bids: [
          {
            bid_id: bid.bidId,
            bidder_code: bid.bidder,
            request_timestamp: data.start,
          },
        ],
        params: getRequestParams(bid, data),
      };
    }),
  }]);
}

function fillResponsePayload(responsePayload, data, statusCode) {
  responsePayload.prebid_auction_id = data.auctionId;
  responsePayload.ad_units = [
    {
      ad_unit_code: data.adUnitCode,
      bids: [
        {
          bid_id: data.adId,
          bidder_code: data.bidder,
          price: data.cpm,
          status_code: statusCode,
          bidder_ad_unit_id: data.adUnitCode,
          request_timestamp: data.requestTimestamp,
          response_timestamp: data.responseTimestamp,
          creative: {
            creative_id: data.creativeId && String(data.creativeId),
            height: data.height && +data.height,
            width: data.width && +data.width,
            brand: data.brand, // we don't currently support this
          },
        },
      ],
      params: getResponseParams(data),
    },
  ];

  if (data.cpm === 0) {
    responsePayload.ad_units[0].bids[0].status_code = STATUS.NO_BID;
  }

  if (data.source) {
    responsePayload.ad_units[0].bids[0].source = data.source;
  }
}

function bidResponse({ data }) {
  if (!data.adUnitCode) {
    return;
  }
  if (!data.requestTimestamp) {
    return;
  }
  if (data.cpm === Infinity) {
    return;
  }

  if (isDebugDetail()) {
    logMessage("Bid Response for " + data.bidder + ":", data);
  }

  const responsePayload = {
    msg_type: MSG_TYPE.Bid_Response,
  };
  fillResponsePayload(responsePayload, data, STATUS.BID_RECEIVED);

  enqueue([responsePayload]);
}

function bidWon({ data }) {
  if (!data.adUnitCode) {
    return;
  }
  if (data.cpm === Infinity) {
    return;
  }

  if (isDebugDetail()) {
    logMessage("Bid Won for " + data.bidder + ":", data);
  }

  const bidWonPayload = {
    msg_type: MSG_TYPE.Bid_Won,
  };
  fillResponsePayload(bidWonPayload, data, STATUS.BID_WON);

  // log "bid won" for the winning bid of a placement
  enqueue([bidWonPayload]);

  /*
  // get other bids in the auction for the placement and log "bid lost" status code
  _queue = _queue.concat(pbjs.getBidResponsesForAdUnitCode(data.adUnitCode).bids
    .filter(bid => bid !== data && bid.adUnitCode === data.adUnitCode)
    .map(bid => {
      return {
        prebid_auction_id: bid.auctionId,
        msg_type: MSG_TYPE.Bid_Lost,
        ad_units: [
          {
            ad_unit_code: bid.adUnitCode,
            bids: [
              {
                bid_id: bid.adId,
                bidder_code: bid.bidder,
                status_code: STATUS.BID_LOST // Bid lost auction
              }
            ],
            params: getBidParms(bid)
          }
        ]
      };
    }));
  */
}

function bidTimeout({ data = [] }) {
  data.forEach((bid) => timedOutBidIds.add(bid.bidId));
  enqueue(
    data.map((bid) => {
      return {
        prebid_auction_id: bid.auctionId,
        msg_type: MSG_TYPE.Bid_Timeout,
        ad_units: [
          {
            ad_unit_code: bid.adUnitCode,
            bids: [
              {
                bid_id: bid.bidId,
                bidder_code: bid.bidder,
                status_code: STATUS.BID_TIMEOUT, // Bid received after timeout reached
              },
            ],
            params: getBidParms(bid),
          },
        ],
      };
    })
  );
}

/**
 * A bid request the bidder answered without a bid. Prebid sets
 * requestTimestamp/responseTimestamp on the request when it records the
 * no-bid, so the message carries the bidder's response time.
 */
function noBid({ data }) {
  if (!includeNoBids || !data || !data.adUnitCode) {
    return;
  }
  // Already sent as a timeout; a late "no bid" must not count it twice.
  if (timedOutBidIds.has(data.bidId)) {
    return;
  }
  enqueue([
    {
      prebid_auction_id: data.auctionId,
      msg_type: MSG_TYPE.Bid_No_Bid,
      ad_units: [
        {
          ad_unit_code: data.adUnitCode,
          bids: [
            {
              bid_id: data.bidId,
              bidder_code: data.bidder,
              status_code: STATUS.NO_BID,
              request_timestamp: data.requestTimestamp,
              response_timestamp: data.responseTimestamp,
            },
          ],
          params: getBidParms(data),
        },
      ],
    },
  ]);
}
