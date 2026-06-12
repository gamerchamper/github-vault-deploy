const { launchDesktop } = require('./desktop');

const portArg = process.argv.find(arg => arg.startsWith('--port='));
const hostArg = process.argv.find(arg => arg.startsWith('--host='));

launchDesktop({
  port: portArg ? parseInt(portArg.slice('--port='.length), 10) : 0,
  host: hostArg ? hostArg.slice('--host='.length) : '127.0.0.1',
}).catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
