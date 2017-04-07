const ProvaTestNode = require('../src/node').ProvaTestNode;
const BTCDTestCluster = require('../src/node').BTCDTestCluster;
const ProvaTestCluster = require('../src/node').ProvaTestCluster;
const Promise = require('bluebird');
const co = Promise.coroutine;
const prova = require('prova');
const should = require('should');
const crypto = require('crypto');
const _ = require('lodash');
const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');

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

const Thread = {
  Root: 0,
  Provision: 1,
  Issue: 2
};

const AdminOpNames = _.invert(AdminOp);

var rootKeys = [
  "eaf02ca348c524e6392655ba4d29603cd1a7347d9d65cfe93ce1ebffdca22694",
  "2b8c52b77b327c755b9b375500d3f4b2da9b0a1ff65f6891d311fe94295bc26a"
].map((hex) => prova.ECPair.fromPrivateKeyBuffer(new Buffer(hex, 'hex'), prova.networks.rmgTest));

const rootPubKeys = rootKeys.map((k) => k.getPublicKeyBuffer().toString('hex'));

let node;
let provisionKeys = [];
let nextKeyId = 3;

const adminThreadScript = function(threadId) {
  threadHex = ['00', '51', '52'];
  return new Buffer(threadHex[threadId] + 'bb', 'hex');
};

const provaScript = function(addr) {
  return prova.Address.fromBase58(addr).toScript();
};

const nullDataScript = function(hex) {
  return prova.script.nullData.output.encode(new Buffer(hex, 'hex'))
};

const newTxBuilder = function() {
  return new prova.TransactionBuilder(prova.networks.rmgTest);
};

const adminKeyScript = function(opType, key, keyId) {
  assert(AdminOpNames[opType]);
  var pieces = [];
  pieces.push(new Buffer([opType]));
  pieces.push(new Buffer(key, 'hex'));
  if (keyId) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(keyId);
    pieces.push(buf);
  }
  return prova.script.nullData.output.encode(Buffer.concat(pieces));
};

const randomKey = function() {
  return prova.ECPair.makeRandom(prova.networks.rmgTest);
};

const randomKeys = function(count) {
  return _.range(0, count).map(() => randomKey());
};

const randomPubKey = function() {
  return randomKey().getPublicKeyBuffer().toString('hex');
};

const getCoinbaseTx = co(function *(node, blocksAgo) {
  const info = yield node.getinfo();
  const height = info.blocks;
  const blockhash = yield node.getblockhash(height - blocksAgo);
  const block = yield node.getblock(blockhash, true);
  const txid = block.tx[0];
  const tx = yield node.getrawtransaction(txid, 1);
  return tx;
});

const expectSendError = co(function *(node, txHex, expectedError) {
  try {
    yield node.sendrawtransaction(txHex);
    throw new Error('should not reach');
  } catch (e) {
    e.message.should.containEql(expectedError);
  }
});

const expectMempoolSize = co(function *(node, size) {
  const info = yield node.getmempoolinfo();
  info.size.should.equal(size);
});

const expectCurrentBlockTransactionCount = co(function *(node, count, toBeFound) {
  const hash = yield node.getbestblockhash();
  const block = yield node.getblock(hash, true);
  block.tx.should.have.length(count);
  if (toBeFound) {
    toBeFound.forEach(function(item) {
      block.tx.indexOf(item).should.not.equal(-1);
    });
  }
});

const makeAdminTxBuilder = co(function *(node, threadId, signingKeys, munge) {
  const threadTip = yield node.getThreadTip(threadId);
  const script = adminThreadScript(threadId);
  var builder = newTxBuilder();
  builder.addInput(threadTip.txid, threadTip.vout);
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

describe('Functional Tests', () => {

  before(co(function *() {
    cluster = new ProvaTestCluster({ size: 2, basePort: 5000});
    yield cluster.start();
    yield cluster.connectAll();
    node = cluster.nodes[0];
    yield node.generate(105);
  }));

  after(co(function *() {
    yield cluster.stop();
    yield cluster.waitTillDone(true);
  }));

  describe('Root Thread', () => {

    it('should fail with no outputs', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Root, rootKeys, function(builder) {
        builder.tx.outs.shift(); // remove first output
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: transaction has no outputs');
    }));

    it('should fail without thread output', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        builder.tx.outs = [];
        builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyAdd, randomPubKey()), 0);
      });
      expectSendError(node, tx, 'spends admin output, yet does not continue admin thread. Should have admin output at position 0.');
    }));

    it('should fail without any operations', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys);
      yield expectSendError(node, tx, 'TX rejected: admin transaction with no admin operations.');
    }));

    it('should fail with additional root thread output', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        builder.addOutput(adminThreadScript(0), 0);
      });
      yield expectSendError(node, tx, 'TX rejected: transaction output 1: admin output only allowed at position 0.');
    }));

    it('should fail with additional other thread output', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        builder.addOutput(adminThreadScript(1), 0);
      });
      yield expectSendError(node, tx, 'TX rejected: transaction output 1: admin output only allowed at position 0.');
    }));

    it('should fail with wrong thread output', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        builder.tx.outs = [];
        builder.addOutput(adminThreadScript(1), 0);
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyAdd, randomPubKey()), 0);
      });
      yield expectSendError(node, tx, 'is spending wrong thread.');
    }));

    it('should fail if thread output not first', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        builder.addOutput(node.miningAddress.toScript(), 0);
        builder.tx.outs.reverse();
      });
      yield expectSendError(node, tx, 'TX rejected: transaction output 1: admin output only allowed at position 0.');
    }));

    it('should fail with random nulldata extra output', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        builder.addOutput(nullDataScript('deadbeef'), 0);
      });
      yield expectSendError(node, tx, 'TX rejected: admin transaction with invalid admin operation found.');
    }));

    it('should fail with nonzero value on thread output', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        builder.tx.outs[0].value = 1;
      });
      yield expectSendError(node, tx, 'TX rejected: admin transaction with non-zero value output #0.');
    }));

    it('should fail with other input in first position', co(function *() {
      const inputTx = yield getCoinbaseTx(node, 101);
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Root, rootKeys, function(builder) {
        builder.addInput(inputTx.txid, 0);
        builder.tx.ins.reverse();
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: admin transaction with more than 1 input.');
    }));

    it('should fail with other input in second position', co(function *() {
      const inputTx = yield getCoinbaseTx(node, 101);
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Root, rootKeys, function(builder) {
        builder.addInput(inputTx.txid, 0);
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: admin transaction with more than 1 input.');
    }));

    it('should fail if admin op has value', co(function *() {
      const provisionKey = prova.ECPair.makeRandom();
      const pubkey = provisionKey.getPublicKeyBuffer().toString('hex');
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyAdd, randomPubKey()), 1337);
      });
      yield expectSendError(node, tx, 'TX rejected: admin transaction with non-zero value output #1.');
    }));

    it('should fail if not fully signed', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Root, rootKeys.slice(1), function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyAdd, randomPubKey()), 0);
      });
      expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: failed to validate input');
    }));

    it('should fail if incorrectly signed', co(function *() {
      const fakeKeys = randomKeys(2);
      const txBuilder = yield makeAdminTxBuilder(node, 0, fakeKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyAdd, randomPubKey()), 0);
      });
      expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: failed to validate input');
    }));

    // Provision key add/remove ops

    it('should add a single provision key', co(function *() {
      const provisionKey = prova.ECPair.makeRandom();
      const pubkey = provisionKey.getPublicKeyBuffer().toString('hex');
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
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
      const keys = randomKeys(5).map((key) => key.getPublicKeyBuffer().toString('hex'));
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
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
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
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
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        var keyHex = prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex');
        builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyRevoke, keyHex), 0);
      });
      expectSendError(node, tx, 'tries to remove non-existing key');
    }));

    // Issue key add/remove ops

    it('should add a single issue key', co(function *() {
      const key = prova.ECPair.makeRandom();
      const pubkey = key.getPublicKeyBuffer().toString('hex');
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
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
      const keys = randomKeys(5).map((key) => key.getPublicKeyBuffer().toString('hex'));
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
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
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
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
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        var keyHex = prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex');
        builder.addOutput(adminKeyScript(AdminOp.IssueKeyRevoke, keyHex), 0);
      });
      expectSendError(node, tx, 'tries to remove non-existing key');
    }));

    it('should fail to add validate key (wrong thread)', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Root, rootKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyAdd, randomPubKey()), 0);
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: admin transaction with invalid admin operation found.');
    }));

    it('should fail to add ASP key (wrong thread)', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Root, rootKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey()), 0);
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: admin transaction with invalid admin operation found.');
    }));

  }); // end Root Thread

  describe('Provision Thread', () => {

    let provisionKeys = [];
    let testKey;

    before(co(function *() {
      // Remove all existing provision keys
      let info = yield node.getadmininfo();
      if (info.provisionkeys) {
        const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
          info.provisionkeys.forEach(function(key) {
            builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyRevoke, key), 0);
          });
        });
        yield node.sendrawtransaction(tx);
        yield node.generate(1);
        info = yield node.getadmininfo();
        info.should.not.have.property('provisionkeys');
      }
    }));

    it('should fail with no keys defined', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, rootKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyAdd, randomPubKey()), 0);
      });
      yield expectSendError(node, tx, 'invalid chain state, at least 2 keys required for thread');
    }));

    it('should add 2 provision keys (needed for rest of tests)', co(function *() {
      // Save these for later use
      provisionKeys = randomKeys(2);
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        provisionKeys.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyAdd, key.getPublicKeyBuffer().toString('hex')), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      info = yield node.getadmininfo();
      info.should.have.property('provisionkeys');
      info.provisionkeys.should.have.length(2);
    }));

    it('should fail if partially signed', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Provision, provisionKeys.slice(1), function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyAdd, randomPubKey()), 0);
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: failed to validate input');
    }));

    it('should fail removing nonexistent validate key', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyRevoke, randomPubKey()), 0);
      });
      yield expectSendError(node, tx, 'tries to remove non-existing key');
    }));

    it('should fail removing nonexistent ASP key', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, randomPubKey(), 33), 0);
      });
      yield expectSendError(node, tx, 'It does not exist in admin set.');
    }));

    it('should fail removing nonexistent ASP key', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, randomPubKey(), 33), 0);
      });
      yield expectSendError(node, tx, 'It does not exist in admin set.');
    }));

    it('should fail adding an existing ASP keyid', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), 1), 0);
      });
      yield expectSendError(node, tx, 'exists already in admin set. Operation rejected.');
    }));

    it('should fail adding an ASP keyid which is not in sequential order', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), 4), 0);
      });
      yield expectSendError(node, tx, 'rejected. should be 3');
    }));

    it('should add a validator key and an ASP key', co(function *() {
      testKey = randomPubKey();
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyAdd, testKey), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, testKey, nextKeyId), 0);
      });
      nextKeyId++;
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      info = yield node.getadmininfo();
      info.validatekeys.should.containEql(testKey);
      _(info.aspkeys).map('pubkey').value().should.containEql(testKey);
    }));

    it('should remove a validator key', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyRevoke, testKey), 0);
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      info = yield node.getadmininfo();
      info.validatekeys.should.not.containEql(testKey);
    }));

    it('should fail to remove keyid if key does not match', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, randomPubKey(), nextKeyId-1), 0);
      });
      yield expectSendError(node, tx, 'can not be revoked in transaction');
    }));

    it('should remove keyid if key does match', co(function *() {
      const aspKey = _((yield node.getadmininfo()).aspkeys).filter({ keyid: nextKeyId-1 }).value()[0];
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, aspKey.pubkey, nextKeyId-1), 0);
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      info = yield node.getadmininfo();
      _(info.aspkeys).map('pubkey').value().should.not.containEql(aspKey.pubkey);
    }));

    it('should fail adding keyid for a second time (new key)', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), nextKeyId-1), 0);
      });
      yield expectSendError(node, tx, 'rejected. should be');
    }));

    it('should fail adding keyid for a second time (same key)', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, testKey, nextKeyId-1), 0);
      });
      yield expectSendError(node, tx, 'rejected. should be ' + nextKeyId);
    }));

    it('should fail adding keyid twice in same tx', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), nextKeyId), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), nextKeyId), 0);
      });
      yield expectSendError(node, tx, 'rejected');
    }));

    it('should fail adding 2 keys with keyids out of order', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), nextKeyId+1), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), nextKeyId), 0);
      });
      yield expectSendError(node, tx, 'rejected');
    }));

    it('should fail adding then removing keyid in same tx', co(function *() {
      const key = randomPubKey();
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, key, nextKeyId), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, key, nextKeyId), 0);
      });
      yield expectSendError(node, tx, 'can not be revoked in transaction');
    }));

    it('should fail removing then adding keyid 4 in same tx', co(function *() {
      const key = randomPubKey();
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, key, nextKeyId), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, key, nextKeyId), 0);
      });
      yield expectSendError(node, tx, 'can not be revoked in transaction');
    }));

    it('should succeed adding same key twice as different keyid', co(function *() {
      const key = randomPubKey();
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, key, nextKeyId), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, key, nextKeyId+1), 0);
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      nextKeyId += 2;
    }));

    it('should succeed adding 2 keys with keyids in correct order', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), nextKeyId), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), nextKeyId+1), 0);
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      nextKeyId += 2;
    }));

  }); // end Provision Thread

  describe('Issue Thread', () => {

    let issueKeys = [];
    let supply = 0;
    let issueTxid;
    let issueVouts;
    const issueAmount = 1e9;

    before(co(function *() {
      // Remove all existing issue keys
      let info = yield node.getadmininfo();
      if (info.issuekeys) {
        const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
          info.issuekeys.forEach(function(key) {
            builder.addOutput(adminKeyScript(AdminOp.IssueKeyRevoke, key), 0);
          });
        });
        yield node.sendrawtransaction(tx);
        yield node.generate(1);
        info = yield node.getadmininfo();
        info.should.not.have.property('issuekeys');
      }
    }));

    it('should fail with no issue keys defined', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, rootKeys, function(builder) {
        builder.addOutput(node.miningAddress.toScript(), issueAmount);
      });
      yield expectSendError(node, tx, 'invalid chain state, at least 2 keys required for thread');
    }));

    it('should add 2 issue keys (needed for rest of tests)', co(function *() {
      // Save these for later use
      issueKeys = randomKeys(2);
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        issueKeys.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.IssueKeyAdd, key.getPublicKeyBuffer().toString('hex')), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      const info = yield node.getadmininfo();
      info.should.have.property('issuekeys');
      info.issuekeys.should.have.length(2);
    }));

    it('should fail if partially signed', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, issueKeys.slice(1), function(builder) {
        builder.addOutput(node.miningAddress.toScript(), issueAmount);
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: failed to validate input');
    }));

    it('should fail to issue a zero amount', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        builder.addOutput(node.miningAddress.toScript(), 0);
      });
      yield expectSendError(node, tx, 'trying to issue 0 at output #1');
    }));

    it('should fail to issue a too large amount (single output)', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        builder.addOutput(node.miningAddress.toScript(), 21e14);
        // tx builder won't take a larger number than 21e14, so we have to hack it
        builder.tx.outs[0].value += 1;
      });
      yield expectSendError(node, tx, 'TX rejected: total value of all transaction outputs is 2100000000000001 which is higher than max allowed value');
    }));

    it('should fail to issue a too large amount (multiple outputs)', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        builder.addOutput(node.miningAddress.toScript(), 21e14);
        builder.addOutput(node.miningAddress.toScript(), 1);
      });
      yield expectSendError(node, tx, 'TX rejected: total value of all transaction outputs is 2100000000000001 which is higher than max allowed value');
    }));

    it('should issue to a single output', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        builder.addOutput(node.miningAddress.toScript(), issueAmount);
      });
      supply += issueAmount;
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      const info = yield node.getadmininfo();
      info.totalsupply.should.equal(supply);
    }));

    it('should fail if nulldata output is included', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        builder.addOutput(node.miningAddress.toScript(), issueAmount);
        builder.addOutput(nullDataScript('deadbeef'), 0);
      });
      yield expectSendError(node, tx, 'tries to destroy funds');
    }));

    it('should issue to multiple outputs', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        _.range(0,9).forEach(() => builder.addOutput(node.miningAddress.toScript(), issueAmount));
      });
      supply += 9 * issueAmount;
      issueTxid = yield node.sendrawtransaction(tx);
      issueVouts = _.range(1, 10);
      yield node.generate(1);
      const info = yield node.getadmininfo();
      info.totalsupply.should.equal(supply);
    }));

    it('should fail if not enough actually destroyed', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, [], function(builder) {
        builder.addInput(issueTxid, issueVouts[0]);
        builder.addOutput(nullDataScript('deadbeef'), 5e8);
      });
      issueKeys.forEach(function(key) {
        txBuilder.sign(0, key, adminThreadScript(Thread.Issue), 0);
      });
      // Address uses root keys
      rootKeys.forEach(function(key) {
        txBuilder.sign(1, key, node.miningAddress.toScript(), issueAmount);
      });
      const tx = txBuilder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: transaction fee 500000000 is greater than the maximum fee limit');
    }));

    it('should fail if too much destroyed (no change)', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, [], function(builder) {
        builder.addInput(issueTxid, issueVouts[0]);
        builder.addOutput(nullDataScript('deadbeef'), 2 * issueAmount);
      });
      issueKeys.forEach(function(key) {
        txBuilder.sign(0, key, adminThreadScript(Thread.Issue), 0);
      });
      // Address uses root keys
      rootKeys.forEach(function(key) {
        txBuilder.sign(1, key, node.miningAddress.toScript(), issueAmount);
      });
      const tx = txBuilder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: total value of all transaction inputs for transaction');
    }));

    it('should fail if too much destroyed by 2 outs (no change)', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, [], function(builder) {
        builder.addInput(issueTxid, issueVouts[0]);
        builder.addOutput(nullDataScript('deadbeef'), 8e8);
        builder.addOutput(nullDataScript('deadbeef'), 8e8);
      });
      issueKeys.forEach(function(key) {
        txBuilder.sign(0, key, adminThreadScript(Thread.Issue), 0);
      });
      // Address uses root keys
      rootKeys.forEach(function(key) {
        txBuilder.sign(1, key, node.miningAddress.toScript(), issueAmount);
      });
      const tx = txBuilder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: total value of all transaction inputs for transaction');
    }));

    it('should fail if too much destroyed (with change)', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, [], function(builder) {
        builder.addInput(issueTxid, issueVouts[0]);
        builder.addOutput(node.miningAddress.toScript(), 8e8);
        builder.addOutput(nullDataScript('deadbeef'), 8e8);
      });
      issueKeys.forEach(function(key) {
        txBuilder.sign(0, key, adminThreadScript(Thread.Issue), 0);
      });
      // Address uses root keys
      rootKeys.forEach(function(key) {
        txBuilder.sign(1, key, node.miningAddress.toScript(), issueAmount);
      });
      const tx = txBuilder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: total value of all transaction inputs for transaction');
    }));

    it('should destroy funds successfully', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, [], function(builder) {
        builder.addInput(issueTxid, issueVouts.shift());
        builder.addInput(issueTxid, issueVouts.shift());
        builder.addOutput(nullDataScript(''), issueAmount);
        builder.addOutput(node.miningAddress.toScript(), issueAmount);
      });
      issueKeys.forEach(function(key) {
        txBuilder.sign(0, key, adminThreadScript(Thread.Issue), 0);
      });
      // Address uses root keys
      rootKeys.forEach(function(key) {
        txBuilder.sign(1, key, node.miningAddress.toScript(), issueAmount);
        txBuilder.sign(2, key, node.miningAddress.toScript(), issueAmount);
      });
      const tx = txBuilder.build().toHex();
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      supply -= issueAmount;
      const info = yield node.getadmininfo();
      info.totalsupply.should.equal(supply);
    }));

  }); // end Issue Thread

  describe('Regular Transactions', () => {

    let issueKeys;
    let provisionKeys;
    let issueTxid;
    let issueVouts;
    let coinbaseTxid;
    let coinbaseSpendingTx;
    let script;
    let keys;
    let aspKey;
    const issueAmount = 1e9;

    before(co(function *() {
      script = node.miningAddress.toScript();
      keys = [rootKeys[0], node.addressKey];
      keys.reverse();

      // Set up 2 issue keys
      issueKeys = randomKeys(2);
      let tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        issueKeys.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.IssueKeyAdd, key.getPublicKeyBuffer().toString('hex')), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);

      // Set up 2 provision keys
      provisionKeys = randomKeys(2);
      tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        provisionKeys.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyAdd, key.getPublicKeyBuffer().toString('hex')), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);

      // Issue some coins
      tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        _.range(0,9).forEach(() => builder.addOutput(node.miningAddress.toScript(), issueAmount));
      });
      issueTxid = yield node.sendrawtransaction(tx);
      issueVouts = _.range(1, 10);
      yield node.generate(1);
    }));

    it('should fail to spend with too high a fee', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(script, issueAmount - 5e6 - 1);
      rootKeys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: transaction fee 5000001 is greater than the maximum fee limit 5000000');
    }));

    it('should fail if outputs greater than inputs', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(script, issueAmount + 1);
      rootKeys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: total value of all transaction inputs for transaction');
    }));

    it('should fail if more than 1 nulldata output', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(script, issueAmount);
      builder.addOutput(nullDataScript('deadbeef01'), 0);
      builder.addOutput(nullDataScript('deadbeef02'), 0);
      keys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: transaction is not of an allowed form');
    }));

    it('should fail if has nonzero nulldata output', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(script, issueAmount - 100);
      builder.addOutput(nullDataScript('deadbeef'), 100);
      keys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: transaction is not of an allowed form');
    }));

    it('should fail with bitcoin-style P2PKH output', co(function *() {
      const outputScript = prova.script.pubKeyHash.output.encode(bitcoin.crypto.hash160(randomKey().getPublicKeyBuffer()));
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(script, issueAmount / 2);
      builder.addOutput(outputScript, issueAmount / 2);
      keys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: transaction is not of an allowed form');
    }));

    it('should fail with checkthread output', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(adminThreadScript(0), 0);
      builder.addOutput(script, 0);
      keys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: admin transaction with invalid admin operation found');
    }));

    it('should fail sending to address with 2 identical valid keyids', co(function *() {
      const badAddr = new prova.Address(prova.ECPair.makeRandom().getPublicKeyBuffer(), 1, 1);
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(badAddr.toScript(), issueAmount);
      keys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: transaction is not of an allowed form');
    }));

    it('should fail sending to address with an invalid keyid', co(function *() {
      const badAddr = new prova.Address(prova.ECPair.makeRandom().getPublicKeyBuffer(), 1, 99);
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(badAddr.toScript(), issueAmount);
      keys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build().toHex();
      yield expectSendError(node, tx, 'output 0 has unknown keyID 99');
    }));

    it('should fail if signed by insufficient keys', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(script, issueAmount);
      keys.slice(1).forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.buildIncomplete().toHex();
      yield expectSendError(node, tx, 'TX rejected: failed to validate input ');
    }));

    it('should fail if signed by wrong keys', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts[0]);
      builder.addOutput(script, issueAmount);
      const fakeKeys = [ keys[0], randomKey() ];
      fakeKeys.slice(1).forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.buildIncomplete().toHex();
      yield expectSendError(node, tx, 'TX rejected: failed to validate input ');
    }));

    it('should spend successfully with max fee', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts.shift());
      builder.addOutput(script, issueAmount - 5e6);
      keys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build().toHex();
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
    }));

    it('should fail to spend immature coinbase output', co(function *() {
      // Get current block's coinbase tx, which should have a fee worth 5e6 from prior tx
      const blockHash = yield node.getbestblockhash();
      const block = yield node.getblock(blockHash);
      coinbaseTxid = block.tx[0];
      const coinbaseTx = yield node.getrawtransaction(coinbaseTxid, 1);
      coinbaseTx.vout.should.have.length(1);
      coinbaseTx.vout[0].value.should.equal(5);

      const builder = newTxBuilder();
      builder.addInput(coinbaseTxid, 0);
      builder.addOutput(script, 5e6);
      keys.forEach((key) => builder.sign(0, key, script, 5e6));
      coinbaseSpendingTx = builder.build();
      yield expectSendError(node, coinbaseSpendingTx.toHex(), 'before required maturity');
    }));

    it('should fail to spend immature coinbase after 98 blocks', co(function *() {
      yield node.generate(98);
      yield expectSendError(node, coinbaseSpendingTx.toHex(), 'before required maturity');
    }));

    it('should succeed spending coinbase after 99 blocks', co(function *() {
      yield node.generate(1);
      const txid = yield node.sendrawtransaction(coinbaseSpendingTx.toHex());
      txid.should.equal(coinbaseSpendingTx.getId());
      yield expectMempoolSize(node, 1);
      yield node.generate(1);
      yield expectMempoolSize(node, 0);
    }));

    it('should succeed spending standard tx output in next block', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(coinbaseSpendingTx.getId(), 0);
      builder.addOutput(script, 5e6);
      keys.forEach((key) => builder.sign(0, key, script, 5e6));
      const tx = builder.build();
      const txid = yield node.sendrawtransaction(tx.toHex());
      txid.should.equal(tx.getId());
      yield expectMempoolSize(node, 1);
      yield node.generate(1);
      yield expectMempoolSize(node, 0);
    }));

    it('should succeed spending a chain of transactions in same block', co(function *() {
      const txs = [];
      const txids = [];
      var prevTxid = issueTxid;
      var prevVout = issueVouts.shift();
      // Make a chain of 8 transactions
      _.range(0, 8).forEach(function() {
        const builder = newTxBuilder();
        builder.addInput(prevTxid, prevVout);
        builder.addOutput(script, issueAmount);
        keys.forEach((key) => builder.sign(0, key, script, issueAmount));
        const tx = builder.build();
        txs.push(tx);
        prevTxid = tx.getId();
        txids.push(prevTxid);
        prevVout = 0;
      });

      while (txs.length) {
        const tx = txs.shift();
        const txid = yield node.sendrawtransaction(tx.toHex());
        txid.should.equal(tx.getId());
      }
      yield expectMempoolSize(node, 8);
      yield node.generate(1);
      yield expectMempoolSize(node, 0);
      yield expectCurrentBlockTransactionCount(node, 9, txids);
    }));

    it('should spend successfully if 1 nulldata output', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts.shift());
      builder.addOutput(script, issueAmount);
      builder.addOutput(nullDataScript('deadbeef'), 0);
      keys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build();
      const txid = yield node.sendrawtransaction(tx.toHex());
      txid.should.equal(tx.getId());
      yield node.generate(1);
      expectMempoolSize(node, 0);
    }));

    it('should spend successfully using both ASP keys', co(function *() {
      const builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts.shift());
      builder.addOutput(script, issueAmount);
      rootKeys.forEach((key) => builder.sign(0, key, script, issueAmount));
      const tx = builder.build();
      const txid = yield node.sendrawtransaction(tx.toHex());
      txid.should.equal(tx.getId());
      yield node.generate(1);
      yield expectMempoolSize(node, 0);
    }));

    it('should be able to spend to/from an address with a new ASP key', co(function *() {
      // Add the new ASP key
      aspKey = randomKey();
      let tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, aspKey.getPublicKeyBuffer().toString('hex'), nextKeyId), 0);
      });
      // Send, but don't mine
      yield node.sendrawtransaction(tx);

      // Define a new address which uses a yet-to-be-added ASP key
      const addrKey = randomKey();
      const addr = new prova.Address(addrKey.getPublicKeyBuffer(), 1, nextKeyId, prova.networks.rmgTest);

      // Build a tx sending to it
      let builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts.shift());
      builder.addOutput(addr.toScript(), issueAmount);
      rootKeys.forEach((key) => builder.sign(0, key, addr.toScript(), issueAmount));
      tx = builder.build();

      // should fail because admin tx adding ASP key has not yet been mined
      yield expectSendError(node, tx.toHex(), 'output 0 has unknown keyID');

      // mine the admin tx
      yield node.generate(1);

      // now should work
      let txid = yield node.sendrawtransaction(tx.toHex());
      txid.should.equal(tx.getId());

      // make sure we can spend it with the new ASP key
      builder = newTxBuilder();
      builder.addInput(txid, 0);
      builder.addOutput(addr.toScript(), issueAmount);
      [addrKey, aspKey].forEach((key) => builder.sign(0, key, addr.toScript(), issueAmount));
      tx = builder.build();
      txid = yield node.sendrawtransaction(tx.toHex());
      txid.should.equal(tx.getId());
      yield node.generate(1);
      yield expectMempoolSize(node, 0);

      // now kill the ASP key
      tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, aspKey.getPublicKeyBuffer().toString('hex'), nextKeyId), 0);
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);

      // should not be able to move existing funds with the removed ASP key
      builder = newTxBuilder();
      builder.addInput(txid, 0);
      builder.addOutput(script, issueAmount);
      [addrKey, aspKey].forEach((key) => builder.sign(0, key, addr.toScript(), issueAmount));
      tx = builder.build();
      yield expectSendError(node, tx.toHex(), 'TX rejected: failed to validate input');

      // should be able to move these funds with the other 2 keys though
      builder = newTxBuilder();
      builder.addInput(txid, 0);
      builder.addOutput(script, issueAmount);
      [rootKeys[0], addrKey].forEach((key) => builder.sign(0, key, addr.toScript(), issueAmount));
      tx = builder.build();
      txid = yield node.sendrawtransaction(tx.toHex());
      txid.should.equal(tx.getId());
      yield node.generate(1);

      // should now not be able to send to the address that uses the revoked ASP key
      builder = newTxBuilder();
      builder.addInput(issueTxid, issueVouts.shift());
      builder.addOutput(addr.toScript(), issueAmount);
      rootKeys.forEach((key) => builder.sign(0, key, addr.toScript(), issueAmount));
      tx = builder.build();
      yield expectSendError(node, tx.toHex(), 'output 0 has unknown keyID');

      nextKeyId++;
    }));

  }); // end Regular Transactions

  describe('Validators', () => {

    let provisionKeys;

    before(co(function *() {
      // Set up 2 provision keys
      provisionKeys = randomKeys(2);
      tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        provisionKeys.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.ProvisionKeyAdd, key.getPublicKeyBuffer().toString('hex')), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
    }));

    after(co(function *() {
      yield node.setvalidatekeys(node.validateKeys);
    }));

    // TODO: the behavior of setgenerate has changed -- blocks will not get generated without another
    // node attached. these need to be moved to the network test section, or, always fire up 2 nodes
    it('should not be able to create a block with an invalid validator key', co(function *() {
      const badValidatorKey = randomKey();
      yield node.setvalidatekeys([badValidatorKey.getPrivateKeyBuffer().toString('hex')]);
      const blocks = (yield node.getinfo()).blocks;
      // We don't use generate here because it just loops forever if it can't make a block
      yield node.setgenerate(true, 1);
      yield Promise.delay(800);
      yield node.setgenerate(false);
      const newBlocks = (yield node.getinfo()).blocks;
      newBlocks.should.equal(blocks);
    }));

    it('should not be able to create a block with a revoked validator key', co(function *() {
      yield node.setvalidatekeys(node.validateKeys);
      const key = prova.ECPair.fromPrivateKeyBuffer(new Buffer(node.validateKeys[0], 'hex'));
      const pubkey = key.getPublicKeyBuffer().toString('hex');

      // Add a new validator key or otherwise we might hit the 2 key minimum and not be allowed to remove one
      const addTx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyAdd, randomPubKey()), 0);
      });
      yield node.sendrawtransaction(addTx);
      yield node.generate(1);

      // Revoke the first validator key
      const revokeTx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyRevoke, pubkey), 0);
      });
      yield node.sendrawtransaction(revokeTx);
      yield node.generate(1);
      expectMempoolSize(node, 0);

      // Now set the validate key to just this one
      yield node.setvalidatekeys([key.getPrivateKeyBuffer().toString('hex')]);

      let blocks = (yield node.getinfo()).blocks;
      yield node.setgenerate(true, 1);
      yield Promise.delay(800);
      yield node.setgenerate(false);
      const newBlocks = (yield node.getinfo()).blocks;
      newBlocks.should.equal(blocks);

      // Set keys back, confirm we can now generate
      yield node.setvalidatekeys(node.validateKeys.slice(1));
      // yield node.setgenerate(true, 1);
      // yield Promise.delay(1600);
      // yield node.setgenerate(false);
      yield node.generate(1);
      const newBlocks2 = (yield node.getinfo()).blocks;
      newBlocks2.should.equal(blocks + 1);
    }));

  });

});


// Network test helper functions
//
const expectNetworkConvergenceToHash = co(function *(nodes, expectedHash, limitMilliseconds) {
  const start = new Date();
  while (nodes.length) {
    const node = nodes.shift();
    const hash = yield node.getbestblockhash();
    if (hash !== expectedHash) {
      nodes.push(node);
      yield Promise.delay(100);
    }
    if (limitMilliseconds && (new Date() - start) > limitMilliseconds) {
      return false;
    }
  }
  return true;
});

const expectNetworkConvergence = co(function *(nodes, limitMilliseconds) {
  const start = new Date();
  while (true) {
    const hashes = yield Promise.map(nodes, (node) => node.getbestblockhash());
    const heights = _.map((yield Promise.map(nodes, (node) => node.getinfo())), 'blocks');
    const diffValues = _.uniq(hashes).length;
    // console.log('Waiting for convergence: ' + diffValues + ' ' + JSON.stringify(heights));
    if (diffValues == 1) {
      return true;
    }
    yield Promise.delay(250);
    if (limitMilliseconds && (new Date() - start) > limitMilliseconds) {
      return false;
    }
  }
});

describe('Network Tests', () => {

  let cluster;

  before(co(function *() {
    cluster = new ProvaTestCluster({ size: 8, basePort: 4000 });
    yield cluster.start(null);
    yield cluster.connectAll();
  }));

  after(co(function *() {
    yield cluster.stop();
    yield cluster.waitTillDone(true);
  }));

  it('blocks generated on 1 node are seen on all other nodes', co(function *() {
    const node = cluster.nodes[0];
    yield node.generate(1);
    const hash = yield node.getbestblockhash();
    const result = yield expectNetworkConvergenceToHash(cluster.nodes.slice(1), hash, 30000);
    result.should.be.true();
  }));

  it('network should converge if 2 nodes each generate separate blockchains', co(function *() {
    const genNodes = cluster.nodes.slice(0, 4);
    // const evenNodes = cluster.nodes.filter((node, idx) => idx % 2 === 0).slice(0, 2);
    yield Promise.map(genNodes, (node, idx) => node.generate(10 * (1+idx)));
    const result = yield expectNetworkConvergence(cluster.nodes, 300000);
    result.should.be.true();
  }));

  // tx propagation
  // tx to ASP key that has just been created
  // forks (longest wins)
  //

});
