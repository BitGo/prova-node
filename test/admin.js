const ProvaNode = require('../src/node');
const Promise = require('bluebird');
const co = Promise.coroutine;
const prova = require('prova');
const provaAdmin = require('prova-admin');
const should = require('should');
const crypto = require('crypto');
const _ = require('lodash');
const assert = require('assert');

const AdminOp = {
  IssueKeyAdd: 0x01,
  IssueKeyRevoke: 0x02,
  ProvisionKeyAdd: 0x03,
  ProvisionKeyRevoke: 0x04,
  ValidateKeyAdd: 0x11,
  ValidateKeyRevoke: 0x12,
  ASPKeyAdd: 0x13,
  ASPKeyRevoke: 0x14
};

const AdminOpNames = _.invert(AdminOp);

var rootKeys = [
  "eaf02ca348c524e6392655ba4d29603cd1a7347d9d65cfe93ce1ebffdca22694",
  "2b8c52b77b327c755b9b375500d3f4b2da9b0a1ff65f6891d311fe94295bc26a"
].map((hex) => prova.ECPair.fromPrivateKeyBuffer(new Buffer(hex, 'hex'), prova.networks.rmgTest));

var rootPubKeys = rootKeys.map((k) => k.getPublicKeyBuffer().toString('hex'));

let node;
let provisionKeys = [];

const address = 'TCq7ZvyjTugZ3xDY8m1Mdgm95v4QmMpMfm3Fg8GCeE1uf';

const adminThreadScript = function(threadId) {
  return new Buffer('0' + threadId + 'bb', 'hex');
};

const provaScript = function(addr) {
  return prova.Address.fromBase58(addr).toScript();
};

const nullDataScript = function(hex) {
  return prova.script.nullData.output.encode(new Buffer(hex, 'hex'))
};

const adminKeyScript = function(opType, key, keyId) {
  assert(AdminOpNames[opType]);
  var pieces = [];
  pieces.push(new Buffer([opType]));
  pieces.push(new Buffer(key, 'hex'));
  return prova.script.nullData.output.encode(Buffer.concat(pieces));
};

const addRandomProvisionKeyScript = function() {
  var keyHex = prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex');
  return adminKeyScript(AdminOp.ProvisionKeyAdd, keyHex);
};

const expectSendError = co(function *(node, txHex, expectedError) {
  try {
    yield node.sendrawtransaction(txHex);
    throw new Error('should not reach');
  } catch (e) {
    e.message.should.equal(expectedError);
  }
});

const expectMempoolSize = co(function *(node, size) {
  const info = yield node.getmpoolinfo();
  info.size.should.equal(size);
});

const makeAdminTxBuilder = co(function *(node, threadId, signingKeys, munge) {
  const threadTip = yield node.getThreadTip(threadId);
  var builder = new prova.TransactionBuilder(prova.networks.rmgTest);
  builder.addInput(threadTip.txid, threadTip.vout);
  const script = adminThreadScript(threadId);
  builder.addOutput(script, 0);

  if (munge) {
    munge(builder);
  }

  if (builder.tx.ins.length) {
    signingKeys.forEach(function(key) {
      builder.sign(0, key, script, 0);
    });
  }

  return builder;
});

const makeAdminTx = co(function *(node, threadId, signingKeys, munge) {
  const builder = yield makeAdminTxBuilder(node, threadId, signingKeys, munge);
  return builder.build().toHex();
});

describe('Admin Transactions', () => {

  before(co(function *() {
    node = new ProvaNode({
      host: 'localhost',
      port: 18334,
      username: 'user',
      password: 'pass'
    });
    // yield node.generate(105); // TODO: make 100, after we do chain reset each time
  }));

  describe('Root Thread', () => {

    it('should fail with no outputs', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, 0, rootKeys, function(builder) {
        builder.tx.outs.shift(); // remove first output
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: transaction has no outputs');
    }));

    it('should fail without thread output', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.tx.outs = [];
        builder.addOutput(addRandomProvisionKeyScript(), 0);
      });
      try {
        yield node.sendrawtransaction(tx);
        throw new Error('should not reach');
      } catch (e) {
        e.message.should.containEql('spends admin output, yet does not continue admin thread. Should have admin output at position 0.');
      }
    }));

    it('should fail without any operations', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys);
      yield expectSendError(node, tx, 'TX rejected: admin transaction with no admin operations.');
    }));

    it('should fail with additional root thread output', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.addOutput(adminThreadScript(0), 0);
      });
      yield expectSendError(node, tx, 'TX rejected: transaction output 1: admin output only allowed at position 0.');
    }));

    it('should fail with additional other thread output', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.addOutput(adminThreadScript(1), 0);
      });
      yield expectSendError(node, tx, 'TX rejected: admin transaction with invalid admin operation found.');
    }));

    it('should fail with wrong thread output', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.tx.outs = [];
        builder.addOutput(adminThreadScript(1), 0);
      });
      yield expectSendError(node, tx, 'TX rejected: transaction is not of an allowed form');
    }));

    it('should fail if thread output not first', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.addOutput(provaScript(address), 0);
        builder.tx.outs.reverse();
      });
      yield expectSendError(node, tx, 'TX rejected: transaction output 1: admin output only allowed at position 0.');
    }));

    it('should fail with random nulldata extra output', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.addOutput(nullDataScript('deadbeef'), 0);
      });
      yield expectSendError(node, tx, 'TX rejected: admin transaction with invalid admin operation found.');
    }));

    it('should fail with nonzero value on thread output', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.tx.outs[0].value = 1;
      });
      yield expectSendError(node, tx, 'TX rejected: admin transaction with non-zero value output #0.');
    }));

    it('should fail with other input in first position', co(function *() {
      const inputTx = yield node.getCoinbaseTx(101);
      const txBuilder = yield makeAdminTxBuilder(node, 0, rootKeys, function(builder) {
        builder.addInput(inputTx.txid, 0);
        builder.tx.ins.reverse();
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: admin transaction with more than 1 input.');
    }));

    it('should fail with other input in second position', co(function *() {
      const inputTx = yield node.getCoinbaseTx(101);
      const txBuilder = yield makeAdminTxBuilder(node, 0, rootKeys, function(builder) {
        builder.addInput(inputTx.txid, 0);
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: admin transaction with more than 1 input.');
    }));

    it('should fail if admin op has value', co(function *() {
      const provisionKey = prova.ECPair.makeRandom();
      const pubkey = provisionKey.getPublicKeyBuffer().toString('hex');
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.addOutput(addRandomProvisionKeyScript(), 1337);
      });
      yield expectSendError(node, tx, 'TX rejected: admin transaction with non-zero value output #1.');
    }));

    it('should fail if not fully signed', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, 0, rootKeys.slice(1), function(builder) {
        builder.addOutput(addRandomProvisionKeyScript(), 0);
      });
      try {
        yield node.sendrawtransaction(txBuilder.buildIncomplete().toHex());
        throw new Error('should not reach');
      } catch (e) {
        e.message.should.containEql('TX rejected: failed to validate input');
      }
    }));

    it('should fail if incorrectly signed', co(function *() {
      const fakeKeys = _.range(0, 2).map(() => prova.ECPair.makeRandom(prova.networks.rmgTest));
      const txBuilder = yield makeAdminTxBuilder(node, 0, fakeKeys, function(builder) {
        builder.addOutput(addRandomProvisionKeyScript(), 0);
      });
      try {
        yield node.sendrawtransaction(txBuilder.buildIncomplete().toHex());
        throw new Error('should not reach');
      } catch (e) {
        e.message.should.containEql('TX rejected: failed to validate input');
      }
    }));

    // Provision key add/remove ops

    it('should add a single provision key', co(function *() {
      const provisionKey = prova.ECPair.makeRandom();
      const pubkey = provisionKey.getPublicKeyBuffer().toString('hex');
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyAdd, pubkey), 0);
      });
      yield node.sendrawtransaction(tx);
      let info = yield node.getadmininfo();
      if (info.provisionkeys) {
        info.provisionkeys.should.not.containEql(pubkey);
      }
      yield node.generate(1);
      info = yield node.getadmininfo();
      info.provisionkeys.should.containEql(pubkey);
    }));

    it('should add 5 provision keys', co(function *() {
      const keys = _.range(0, 5).map(() => prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex'));
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        keys.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyAdd, key), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      let info = yield node.getadmininfo();
      keys.forEach(function(key) {
        info.provisionkeys.should.not.containEql(key);
      });
      yield node.generate(1);
      info = yield node.getadmininfo();
      keys.forEach(function(key) {
        info.provisionkeys.should.containEql(key);
      });
    }));

    it('should remove provision keys', co(function *() {
      let info = yield node.getadmininfo();
      const keysToRemove = info.provisionkeys.slice(3); // remove all but 3
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        keysToRemove.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyRevoke, key), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      info = yield node.getadmininfo();
      keysToRemove.forEach(function(key) {
        info.provisionkeys.should.not.containEql(key);
      });
    }));

    it('should fail removing nonexistent provision key', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        var keyHex = prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex');
        builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyRevoke, keyHex), 0);
      });
      try {
        yield node.sendrawtransaction(tx);
        throw new Error('should not reach');
      } catch (e) {
        e.message.should.containEql('tries to remove non-existing key');
      }
    }));

    // Issue key add/remove ops

    it('should add a single issue key', co(function *() {
      const key = prova.ECPair.makeRandom();
      const pubkey = key.getPublicKeyBuffer().toString('hex');
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.IssueKeyAdd, pubkey), 0);
      });
      yield node.sendrawtransaction(tx);
      let info = yield node.getadmininfo();
      if (info.issuekeys) {
        info.issuekeys.should.not.containEql(pubkey);
      }
      yield node.generate(1);
      info = yield node.getadmininfo();
      info.issuekeys.should.containEql(pubkey);
    }));

    it('should add 5 issue keys', co(function *() {
      const keys = _.range(0, 5).map(() => prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex'));
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        keys.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.IssueKeyAdd, key), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      let info = yield node.getadmininfo();
      keys.forEach(function(key) {
        info.issuekeys.should.not.containEql(key);
      });
      yield node.generate(1);
      info = yield node.getadmininfo();
      keys.forEach(function(key) {
        info.issuekeys.should.containEql(key);
      });
    }));

    it('should remove issue keys', co(function *() {
      let info = yield node.getadmininfo();
      const keysToRemove = info.issuekeys.slice(3); // remove all but 3
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        keysToRemove.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.IssueKeyRevoke, key), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      info = yield node.getadmininfo();
      keysToRemove.forEach(function(key) {
        info.issuekeys.should.not.containEql(key);
      });
    }));

    it('should fail removing nonexistent issue key', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        var keyHex = prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex');
        builder.addOutput(adminKeyScript(AdminOp.IssueKeyRevoke, keyHex), 0);
      });
      try {
        yield node.sendrawtransaction(tx);
        throw new Error('should not reach');
      } catch (e) {
        e.message.should.containEql('tries to remove non-existing key');
      }
    }));


  });
});
