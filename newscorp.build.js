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
  console.log('dirname', __dirname);
  console.log('filename', __filename);
  console.log('context', process.cwd());
  while (sites.length) {
    const site = sites.shift();
    console.log(`building prebid for: ${site}`);
    console.log(buildPath);
    execSync(buildBuildString(site));
    fs.mkdirSync(`${buildPath}/${site}/`, { recursive: true });
    fs.renameSync(
      `${path.resolve(__dirname)}/build/dist/prebid.js`,
      `${buildPath}/${site}/prebid.js`
    );
  }
}

buildPrebid();
