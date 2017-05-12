const rpc = require('json-rpc2');
const Promise = require('bluebird');
const co = Promise.coroutine;
const Q = require('q');
const spawn = require('child_process').spawn;
const execAsync = Promise.promisify(require('child_process').exec);
const cuid = require('cuid');
const fs = require('fs');
const util = require('util');
const prova = require('prova-lib');
const _ = require('lodash');

class ProvaNode {

  constructor({host, rpcport, username, password}) {
    this.host = host;
    this.rpcport = rpcport;
    this.username = username;
    this.password = password;
    this.addedNodes = {};
    this.client = rpc.Client.$create(rpcport, host, username, password);
  }

  callRPC(cmd, args) {
    args = args || [];
    return Q.nbind(this.client.call, this.client)(cmd, args, { https: true, rejectUnauthorized: false });
  }
}

const methods = [
  'addnode',
  'createrawtransaction',
  'debuglevel',
  'decoderawtransaction',
  'decodescript',
  'generate',
  'getaddednodeinfo',
  'getaddresstxids',
  'getadmininfo',
  'getbestblock',
  'getbestblockhash',
  'getblock',
  'getblockcount',
  'getblockhash',
  'getblockheader',
  'getblocktemplate',
  'getconnectioncount',
  'getcurrentnet',
  'getdifficulty',
  'getgenerate',
  'gethashespersec',
  'getinfo',
  'getmempoolinfo',
  'getmininginfo',
  'getnettotals',
  'getnetworkhashps',
  'getpeerinfo',
  'getrawmempool',
  'getrawtransaction',
  'gettxout',
  'getwork',
  'help',
  'node',
  'ping',
  'searchrawtransactions',
  'sendrawtransaction',
  'setgenerate',
  'setvalidatekeys',
  'stop',
  'submitblock',
  'validateaddress',
  'verifychain',
  'verifymessage'
];

methods.forEach(function(method) {
  ProvaNode.prototype[method] = function() {
    return this.callRPC(method, Array.prototype.slice.call(arguments));
  };
});

ProvaNode.prototype.getThreadTip = co(function *(threadId) {
  const adminInfo = yield this.getadmininfo();
  var parts = adminInfo.threadtips[threadId].outpoint.split(':');
  return {
    txid: parts[0],
    vout: Number(parts[1])
  };
});

ProvaNode.prototype.addNode = function(hostAndPort) {
  this.addedNodes[hostAndPort] = true;
  return this.addnode(hostAndPort, 'add');
};

ProvaNode.prototype.reconnect = function() {
  return Promise.map(_.keys(this.addedNodes), (addr) => this.addnode(addr, 'add'));
};

ProvaNode.prototype.removeAllNodes = function() {
  nodes = _.keys(this.addedNodes);
  this.addedNodes = {};
  return Promise.map(_.keys(this.addedNodes), (addr) => this.addnode(addr, 'remove'));
};

class ProvaTestNode extends ProvaNode {

  constructor({ port }) {
    super({
      host: '127.0.0.1',
      rpcport: port + 10000,
      username: 'test',
      password: 'test'
    });
    this.port = port;

    this.addressKey = prova.ECPair.makeRandom(prova.networks.rmgTest);
    this.miningAddress = new prova.Address(this.addressKey.getPublicKeyBuffer(), [1, 2], prova.networks.rmgTest);

    this.validateKeys = [
      '4015289a228658047520f0d0abe7ad49abc77f6be0be63b36b94b83c2d1fd977',
      '9ade85268e57b7c97af9f84e0d5d96138eae2b1d7ae96c5ab849f58551ab9147',
      'a959753ab5aeb59d7184ba37f6b219492bcb137bb992418590a40fd4ef9facdd',
      'c345ff4a207ed945ac3040a933f386676e9c034f261ad4306f8b34d828eecde6'
    ];
    this.datadir = `/tmp/prova-${this.port}-${cuid()}`;
  }

}

ProvaTestNode.prototype.start = co(function *(debugLevel) {
  try {
    fs.mkdirSync(this.datadir);
  } catch (e) {}
  const args = [
    '--regtest',
    '--txindex',
    '--maxorphantx=100',
    util.format('--miningaddr=%s', this.miningAddress.toString()),
    util.format('--listen=%s:%s', this.host, this.port),
    util.format('--rpcuser=%s', this.username),
    util.format('--rpcpass=%s', this.password),
    util.format('--rpclisten=%s:%s', this.host, this.rpcport),
    util.format('--datadir=%s', this.datadir)
  ];
  if (debugLevel) {
    args.push('-d=' + debugLevel);
  }
  this.proc = spawn('prova', args);

  this.proc.stderr.on('data', (data) => {
    if (debugLevel) {
      console.log(`stderr: ${data}`);
    }
  });

  this.proc.stdout.on('data', (data) => {
    if (debugLevel) {
      console.log(`stdout[${this.port}]: ${data}`);
    }
  });

  this.proc.on('close', (code) => {
    this.done = true;
    if (debugLevel) {
      console.log(`child prova process on port ${this.port} exited with code ${code}`);
    }
  });

  // Wait for RPC server to start
  while (true) {
    yield Promise.delay(100);
    try {
      yield this.getinfo();
      break;
    } catch (e) {
    }
  }
  yield this.setvalidatekeys(this.validateKeys);
});

ProvaTestNode.prototype.waitTillDone = co(function *(shouldCleanup) {
  while (!this.done) {
    yield Promise.delay(100);
  }
  if (shouldCleanup) {
    yield execAsync('rm -rf ' + this.datadir);
  }
});

class BTCDTestNode extends ProvaNode {

  constructor({ port }) {
    super({
      host: '127.0.0.1',
      rpcport: port + 10000,
      username: 'test',
      password: 'test'
    });
    this.port = port;

    this.addressKey = prova.ECPair.makeRandom(prova.networks.rmgTest);
    this.miningAddress = 'n2SjFgAhHAv8PcTuq5x2e9sugcXDpMTzX7';
    this.datadir = `/tmp/btcd-${this.port}-${cuid()}`;
  }

}

BTCDTestNode.prototype.start = co(function *(debugLevel) {
  fs.mkdirSync(this.datadir);
  const args = [
    '--regtest',
    '--txindex',
    util.format('--miningaddr=%s', this.miningAddress.toString()),
    util.format('--listen=%s:%s', this.host, this.port),
    util.format('--rpcuser=%s', this.username),
    util.format('--rpcpass=%s', this.password),
    util.format('--rpclisten=%s:%s', this.host, this.rpcport),
    util.format('--datadir=%s', this.datadir)
  ];
  if (debugLevel) {
    args.push('-d=' + debugLevel);
  }
  this.proc = spawn('btcd', args);

  this.proc.stderr.on('data', (data) => {
    if (debugLevel) {
      console.log(`stderr: ${data}`);
    }
  });

  this.proc.stdout.on('data', (data) => {
    if (debugLevel) {
      console.log(`stdout[${this.port}]: ${data}`);
    }
  });

  this.proc.on('close', (code) => {
    this.done = true;
    if (debugLevel) {
      console.log(`child btcd process on port ${this.port} exited with code ${code}`);
    }
  });

  // Wait for RPC server to start
  while (true) {
    yield Promise.delay(100);
    try {
      yield this.getinfo();
      break;
    } catch (e) {
    }
  }
});

BTCDTestNode.prototype.waitTillDone = co(function *(shouldCleanup) {
  while (!this.done) {
    yield Promise.delay(100);
  }
  if (shouldCleanup) {
    yield execAsync('rm -rf ' + this.datadir);
  }
});

class ProvaTestCluster {
  constructor({ size, basePort }) {
    this.basePort = basePort;
    this.nodes = _.range(0, size).map((index) => new ProvaTestNode({ port: basePort + index }));
  }

  start(debugLevel) {
    const args = debugLevel ? [debugLevel] : undefined;
    return Promise.all(_.invokeMap(this.nodes, 'start', args));
  }

  stop() {
    return Promise.all(_.invokeMap(this.nodes, 'stop'));
  }

  waitTillDone(shouldCleanup) {
    return Promise.all(_.invokeMap(this.nodes, 'waitTillDone', [shouldCleanup]));
  }

  connectAll() {
    const promises = [];
    const nodes = this.nodes;
    nodes.forEach(function(node1, index1) {
      nodes.forEach(function(node2, index2) {
        if (index1 != index2) {
          promises.push(node1.addNode(node2.host + ':' + node2.port, 'add'));
        }
      });
    });
    return Promise.all(promises);
  }

  disconnectAll() {
    return Promise.map(this.nodes, (node) => node.removeAllNodes());
  }
}

ProvaTestCluster.prototype.addNode = co(function *({ start }) {
  const size = this.nodes.length;
  const node = new ProvaTestNode({ port: basePort + size });
  this.nodes.push(node);
  if (start) {
    yield node.start();
  }
  return node;
});

class BTCDTestCluster {
  constructor({ size, basePort }) {
    this.basePort = basePort;
    this.nodes = _.range(0, size).map((index) => new BTCDTestNode({ port: basePort + index }));
  }

  start(debugLevel) {
    const args = debugLevel ? [debugLevel] : undefined;
    return Promise.all(_.invokeMap(this.nodes, 'start', args));
  }

  stop() {
    return Promise.all(_.invokeMap(this.nodes, 'stop'));
  }

  waitTillDone(shouldCleanup) {
    return Promise.all(_.invokeMap(this.nodes, 'waitTillDone', [shouldCleanup]));
  }

  connectAll() {
    const promises = [];
    const nodes = this.nodes;
    nodes.forEach(function(node1, index1) {
      nodes.forEach(function(node2, index2) {
        if (index1 != index2) {
          promises.push(node1.addnode(node2.host + ':' + node2.port, 'add'));
        }
      });
    });
    return Promise.all(promises);
  }
}

BTCDTestCluster.prototype.addNode = co(function *({ start }) {
  const size = this.nodes.length;
  const node = new ProvaTestNode({ port: basePort + size });
  this.nodes.push(node);
  if (start) {
    yield node.start();
  }
  return node;
});


module.exports =
{
  ProvaNode: ProvaNode,
  ProvaTestNode: ProvaTestNode,
  BTCDTestNode: BTCDTestNode,
  ProvaTestCluster: ProvaTestCluster,
  BTCDTestCluster: BTCDTestCluster
};
