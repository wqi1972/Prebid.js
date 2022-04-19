/**
 * appnexus.js - AppNexus Prebid Analytics Adapter
 */

import adapter from '../src/AnalyticsAdapter.js';
import adapterManager from '../src/adapterManager.js';
import {logEvent, sendBatch} from './AppNexusPrebidAnalytics/appnexus.js';

var appnexusAdapter = adapter({
  global: 'AppNexusPrebidAnalytics',
  handler: 'on',
  analyticsType: 'bundle'
});

adapterManager.registerAnalyticsAdapter({
  adapter: appnexusAdapter,
  code: 'appnexus',
  gvlid: 32
});

/**
 * Global function to handle events emitted from Prebid.js AnalyticsAdapter
 */
window.AppNexusPrebidAnalytics = function(handler, eventType, data) {
  logEvent({ eventType, data });
  sendBatch();
};

export default appnexusAdapter;
