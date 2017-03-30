const ProvaTestNode = require('../src/node').ProvaTestNode;
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

var rootPubKeys = rootKeys.map((k) => k.getPublicKeyBuffer().toString('hex'));

let node;
let provisionKeys = [];

const address = 'TCq7ZvyjTugZ3xDY8m1Mdgm95v4QmQ1KUZ3N3Ldf45LDm';

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

const randomPubKey = function() {
  return prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex');
};

const expectSendError = co(function *(node, txHex, expectedError) {
  try {
    yield node.sendrawtransaction(txHex);
    throw new Error('should not reach');
  } catch (e) {
    e.message.should.containEql(expectedError);
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
    node = new ProvaTestNode({ port: 5555 });
    yield node.start();
    yield node.generate(105);
  }));

  after(co(function *() {
    yield node.stop();
    yield node.waitTillDone(true);
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
        builder.addOutput(provaScript(address), 0);
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
      const inputTx = yield node.getCoinbaseTx(101);
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Root, rootKeys, function(builder) {
        builder.addInput(inputTx.txid, 0);
        builder.tx.ins.reverse();
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: admin transaction with more than 1 input.');
    }));

    it('should fail with other input in second position', co(function *() {
      const inputTx = yield node.getCoinbaseTx(101);
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
      const fakeKeys = _.range(0, 2).map(() => prova.ECPair.makeRandom(prova.networks.rmgTest));
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
      const keys = _.range(0, 5).map(() => prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex'));
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
      const keys = _.range(0, 5).map(() => prova.ECPair.makeRandom().getPublicKeyBuffer().toString('hex'));
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
      provisionKeys = _.range(0, 2).map(() => prova.ECPair.makeRandom(prova.networks.rmgTest));
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

    it('should fail adding an ASP keyid which is not in sequential oder', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), 4), 0);
      });
      yield expectSendError(node, tx, 'rejected. should be 3');
    }));

    it('should add a validator key and an ASP key', co(function *() {
      testKey = randomPubKey();
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ValidateKeyAdd, testKey), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, testKey, 3), 0);
      });
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

    // Note, this is kind of broken -- we are just removing keyid 3 using a random key!
    it('should remove keyid 3', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, randomPubKey(), 3), 0);
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      info = yield node.getadmininfo();
      _(info.aspkeys).map('pubkey').value().should.not.containEql(testKey);
    }));

    it('should fail adding keyid 3 for a second time (new key)', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), 3), 0);
      });
      yield expectSendError(node, tx, 'rejected. should be 4');
    }));

    it('should fail adding keyid 3 for a second time (same key)', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, testKey, 3), 0);
      });
      yield expectSendError(node, tx, 'rejected. should be 4');
    }));

    // TODO: fix bug causing test to fail
    xit('should fail adding keyid 4 twice in same tx', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), 4), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, randomPubKey(), 4), 0);
      });
      yield expectSendError(node, tx, 'rejected');
    }));

    it('should fail adding then removing keyid 4 in same tx', co(function *() {
      const key = randomPubKey();
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, key, 4), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, key, 4), 0);
      });
      yield expectSendError(node, tx, 'keyID 4 can not be revoked in transaction');
    }));

    it('should fail removing then adding keyid 4 in same tx', co(function *() {
      const key = randomPubKey();
      const tx = yield makeAdminTx(node, Thread.Provision, provisionKeys, function(builder) {
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyRevoke, key, 4), 0);
        builder.addOutput(adminKeyScript(AdminOp.ASPKeyAdd, key, 4), 0);
      });
      yield expectSendError(node, tx, 'keyID 4 can not be revoked in transaction');
    }));

  }); // end Provision Thread

  describe('Issue Thread', () => {

    let issueKeys = [];
    let supply = 0;
    let issueTxid;
    let issueVouts;

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
        builder.addOutput(provaScript(address), 1e9);
      });
      yield expectSendError(node, tx, 'invalid chain state, at least 2 keys required for thread');
    }));

    it('should add 2 issue keys (needed for rest of tests)', co(function *() {
      // Save these for later use
      issueKeys = _.range(0, 2).map(() => prova.ECPair.makeRandom(prova.networks.rmgTest));
      const tx = yield makeAdminTx(node, Thread.Root, rootKeys, function(builder) {
        issueKeys.forEach(function(key) {
          builder.addOutput(adminKeyScript(AdminOp.IssueKeyAdd, key.getPublicKeyBuffer().toString('hex')), 0);
        });
      });
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      const info = yield node.getadmininfo();
      info.should.have.property('issuekeys');
      info.provisionkeys.should.have.length(2);
    }));

    it('should fail if partially signed', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, issueKeys.slice(1), function(builder) {
        builder.addOutput(provaScript(address), 1e9);
      });
      yield expectSendError(node, txBuilder.buildIncomplete().toHex(), 'TX rejected: failed to validate input');
    }));

    it('should fail to issue a zero amount', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        builder.addOutput(provaScript(address), 0);
      });
      yield expectSendError(node, tx, 'trying to issue 0 at output #1');
    }));

    it('should issue to a single output', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        builder.addOutput(provaScript(address), 1e9);
      });
      supply += 1e9;
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      const info = yield node.getadmininfo();
      info.totalsupply.should.equal(supply);
    }));

    it('should fail if nulldata output is included', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        builder.addOutput(provaScript(address), 1e9);
        builder.addOutput(nullDataScript('deadbeef'), 0);
      });
      yield expectSendError(node, tx, 'tries to destroy funds');
    }));

    it('should issue to multiple outputs', co(function *() {
      const tx = yield makeAdminTx(node, Thread.Issue, issueKeys, function(builder) {
        _.range(0,9).forEach(() => builder.addOutput(provaScript(address), 1e9));
      });
      supply += 9e9;
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
        txBuilder.sign(1, key, provaScript(address), 1e9);
      });
      const tx = txBuilder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: transaction fee 500000000 is greater than the maximum fee limit');
    }));

    it('should fail if too much destroyed (no change)', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, [], function(builder) {
        builder.addInput(issueTxid, issueVouts[0]);
        builder.addOutput(nullDataScript('deadbeef'), 2e9);
      });
      issueKeys.forEach(function(key) {
        txBuilder.sign(0, key, adminThreadScript(Thread.Issue), 0);
      });
      // Address uses root keys
      rootKeys.forEach(function(key) {
        txBuilder.sign(1, key, provaScript(address), 1e9);
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
        txBuilder.sign(1, key, provaScript(address), 1e9);
      });
      const tx = txBuilder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: total value of all transaction inputs for transaction');
    }));

    it('should fail if too much destroyed (with change)', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, [], function(builder) {
        builder.addInput(issueTxid, issueVouts[0]);
        builder.addOutput(provaScript(address), 8e8);
        builder.addOutput(nullDataScript('deadbeef'), 8e8);
      });
      issueKeys.forEach(function(key) {
        txBuilder.sign(0, key, adminThreadScript(Thread.Issue), 0);
      });
      // Address uses root keys
      rootKeys.forEach(function(key) {
        txBuilder.sign(1, key, provaScript(address), 1e9);
      });
      const tx = txBuilder.build().toHex();
      yield expectSendError(node, tx, 'TX rejected: total value of all transaction inputs for transaction');
    }));

    it('should destroy funds successfully', co(function *() {
      const txBuilder = yield makeAdminTxBuilder(node, Thread.Issue, [], function(builder) {
        builder.addInput(issueTxid, issueVouts.shift());
        builder.addInput(issueTxid, issueVouts.shift());
        builder.addOutput(nullDataScript(''), 1e9);
        builder.addOutput(provaScript(address), 1e9);
      });
      issueKeys.forEach(function(key) {
        txBuilder.sign(0, key, adminThreadScript(Thread.Issue), 0);
      });
      // Address uses root keys
      rootKeys.forEach(function(key) {
        txBuilder.sign(1, key, provaScript(address), 1e9);
        txBuilder.sign(2, key, provaScript(address), 1e9);
      });
      const tx = txBuilder.build().toHex();
      yield node.sendrawtransaction(tx);
      yield node.generate(1);
      supply -= 1e9;
      const info = yield node.getadmininfo();
      info.totalsupply.should.equal(supply);
    }));

  }); // end Issue Thread

});