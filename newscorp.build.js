const { config } = require('./newscorp.conf.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const buildPath = `${path.resolve(__dirname)}/prebid/dist`;
const sites = Object.keys(config);

function buildBuildString(site) {
  const modules = config[site].modules.join(',');
  return `${path.resolve(
    __dirname
  )}/node_modules/.bin/gulp build --website ${site} --modules=${modules}`;
}

function buildPrebid() {
  while (sites.length) {
    const site = sites.shift();
    console.log(`building prebid for: ${site}`);
    execSync(buildBuildString(site));
    fs.mkdirSync(`${buildPath}/${site}/`, { recursive: true });
    fs.renameSync(
      `${path.resolve(__dirname)}/build/dist/prebid.js`,
      `${buildPath}/${site}/prebid.js`
    );
  }
}

buildPrebid();
